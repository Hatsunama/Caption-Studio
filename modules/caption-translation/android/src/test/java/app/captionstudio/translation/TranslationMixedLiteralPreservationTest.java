package app.captionstudio.translation;

import static org.junit.Assert.*;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * Acceptance tests through the real asynchronous translator, parser, quality
 * checks, fragment assembly, callbacks, and checkpoint store.
 *
 * Device evidence (final1.4.135): refreshing saved Hello + woman technologist
 * with medium skin tone + sparkles into Spanish ended in QUALITY_REVIEW with
 * PROTECTED_CONTENT on initial and repair attempts; the caller retained Hola.
 * Raw model output is unknown. The omissions and mutations below are explicitly
 * SIMULATED model-boundary faults, not a reconstruction of that device output.
 *
 * These tests specify the human-approved preservation contract. They deliberately
 * do not specify masking, segmentation, prompt wording, fragment IDs, or an exact
 * generation count. No fake performs preservation or supplies a repaired result.
 */
public final class TranslationMixedLiteralPreservationTest {
  private static final String TECHNOLOGIST = "\uD83D\uDC69\uD83C\uDFFD\u200D\uD83D\uDCBB";
  private static final String SPARKLES = "\u2728";
  private static final String EMOJI = TECHNOLOGIST + SPARKLES;
  private static final String BEFORE = "A greeting starts here.";
  private static final String AFTER = "The next speaker responds.";

  @Rule public TemporaryFolder temporary = new TemporaryFolder();

  @Test public void simulatedOmissionPreservesTrailingComplexEmoji() throws Exception {
    expectPreserved("Hello " + EMOJI, "Hola " + EMOJI);
  }

  @Test public void simulatedOmissionPreservesLeadingComplexEmoji() throws Exception {
    expectPreserved(EMOJI + " Hello", EMOJI + " Hola");
  }

  @Test public void simulatedOmissionPreservesRepeatedEmojiCountsAndPositions() throws Exception {
    expectPreserved(EMOJI + " Hello " + EMOJI + " " + SPARKLES,
        EMOJI + " Hola " + EMOJI + " " + SPARKLES);
  }

  @Test public void simulatedOmissionDoesNotInsertSpacesAtAttachedLiteralBoundaries() throws Exception {
    expectPreserved(EMOJI + "Hello" + EMOJI, EMOJI + "Hola" + EMOJI);
  }

  @Test public void simulatedOmissionPreservesRepeatedOpaqueLiteralsExactly() throws Exception {
    String code = "`user_id`";
    String url = "https://example.test/a%2Fb?q=One&x=2";
    expectPreserved(code + " Hello " + url + " " + code,
        code + " Hola " + url + " " + code);
  }

  @Test public void alreadyPreservedModelOutputIsAcceptedWithoutDuplicatingLiterals() throws Exception {
    String source = "Hello " + EMOJI;
    String translated = "Hola " + EMOJI;
    try (Harness harness = new Harness(translated)) {
      assertAccepted(harness.run(source, false, BEFORE, AFTER), translated);
      assertFalse("The mixed cue must use the injected model boundary", harness.prompts.isEmpty());
    }
  }

  @Test public void simulatedSkinToneAndZwjMutationsNeverEscapeAsAcceptedText() throws Exception {
    String[] mutations = {
        "\uD83D\uDC69\u200D\uD83D\uDCBB" + SPARKLES,
        "\uD83D\uDC69\uD83C\uDFFD\uD83D\uDCBB" + SPARKLES,
        EMOJI + SPARKLES
    };
    for (String mutation : mutations) {
      try (Harness harness = new Harness("Hola " + mutation)) {
        Delivery delivery = harness.run("Hello " + EMOJI, false, BEFORE, AFTER);
        // An implementation may exclude literals from inference or reject the
        // corrupted candidate. Accepting the corrupted inventory is never valid.
        for (Map<?, ?> cue : List.of(cue(delivery.result), cue(delivery.batch))) {
          if (Boolean.TRUE.equals(cue.get("valid"))) {
            assertEquals("A corrected acceptance must restore the exact source inventory",
                "Hola " + EMOJI, cue.get("text"));
          } else {
            assertRejected(cue);
          }
        }
      }
    }
  }

  @Test public void emptyProseDoesNotBecomeAnAcceptedEmojiOnlyTranslation() throws Exception {
    try (Harness harness = new Harness("")) {
      Delivery delivery = harness.run("Hello " + EMOJI, false, BEFORE, AFTER);
      assertRejected(cue(delivery.result));
      assertRejected(cue(delivery.batch));
    }
  }

  @Test public void failedRefreshDoesNotOverwritePreviouslyAcceptedCheckpoint() throws Exception {
    String source = "Hello " + EMOJI;
    String translated = "Hola " + EMOJI;
    try (Harness harness = new Harness(translated)) {
      assertAccepted(harness.run(source, false, BEFORE, AFTER), translated);
      int beforeRefresh = harness.prompts.size();
      harness.missingResponse = true;
      Delivery failed = harness.run(source, false, BEFORE, AFTER);
      assertTrue("Refresh must reach inference rather than restore old success",
          harness.prompts.size() > beforeRefresh);
      assertRejected(cue(failed.result));
      assertRejected(cue(failed.batch));
      int afterFailure = harness.prompts.size();
      // Keep the model broken: only the real checkpoint can satisfy resume.
      assertAccepted(harness.run(source, true, BEFORE, AFTER), translated);
      assertEquals("A failed refresh must not replace accepted checkpoint text",
          afterFailure, harness.prompts.size());
    }
  }

  @Test public void failedAttemptCreatesNoFalseAcceptedCheckpoint() throws Exception {
    try (Harness harness = new Harness("Hola")) {
      harness.missingResponse = true;
      Delivery first = harness.run(EMOJI + " Hello", false, BEFORE, AFTER);
      assertRejected(cue(first.result));
      assertRejected(cue(first.batch));
      int failedCalls = harness.prompts.size();
      Delivery resumed = harness.run(EMOJI + " Hello", true, BEFORE, AFTER);
      assertTrue("An unusable response cannot satisfy a later resume",
          harness.prompts.size() > failedCalls);
      assertRejected(cue(resumed.result));
      assertRejected(cue(resumed.batch));
    }
  }

  @Test public void reconstructedOutputRestoresOnlyForItsSourceAndContext() throws Exception {
    String source = EMOJI + " Hello";
    String expected = EMOJI + " Hola";
    try (Harness harness = new Harness("Hola")) {
      assertAccepted(harness.run(source, false, BEFORE, AFTER), expected);
      int freshCalls = harness.prompts.size();
      assertTrue("Valid prose must actually come from the injected runtime", freshCalls > 0);
      assertAccepted(harness.run(source, true, BEFORE, AFTER), expected);
      assertEquals("Resume must restore the reconstructed accepted output",
          freshCalls, harness.prompts.size());
      assertAccepted(harness.run(source, true, "A different greeting.", AFTER), expected);
      assertTrue("Changed source context must invalidate the checkpoint",
          harness.prompts.size() > freshCalls);
      int changedContextCalls = harness.prompts.size();
      String changedSource = EMOJI + " Hello " + EMOJI;
      assertAccepted(harness.run(changedSource, true, "A different greeting.", AFTER),
          EMOJI + " Hola " + EMOJI);
      assertTrue("Changed literal ownership must invalidate the checkpoint",
          harness.prompts.size() > changedContextCalls);
    }
  }

  @Test public void infixLiteralTranslatesBothProsePiecesWithOriginalContext() throws Exception {
    try (Harness harness = new Harness(text -> "friend".equals(text) ? "amigo" : "Hola")) {
      assertAccepted(harness.run("Hello " + EMOJI + " friend", false, BEFORE, AFTER),
          "Hola " + EMOJI + " amigo");
      boolean sawFriend = false;
      for (JsonObject prompt : harness.prompts) {
        if (!"friend".equals(prompt.getAsJsonArray("captions").get(0)
            .getAsJsonObject().get("text").getAsString())) continue;
        sawFriend = true;
        assertEquals(BEFORE, prompt.get("contextBefore").getAsString());
        assertEquals(AFTER, prompt.get("contextAfter").getAsString());
        JsonObject neighbors = prompt.getAsJsonObject("sourceNeighbors");
        assertTrue(neighbors.get("before").getAsString().contains(BEFORE));
        assertTrue(neighbors.get("before").getAsString().contains("Hello " + EMOJI));
        assertEquals(AFTER, neighbors.get("after").getAsString());
      }
      assertTrue("The second prose piece must reach the actual runtime", sawFriend);
    }
  }

  @Test public void recoveryRetainsTabsCrLfAndAttachedSourceSeams() throws Exception {
    String source = "Hello\t" + EMOJI + "\t friend\r\nHello" + SPARKLES + "\tfriend";
    try (Harness harness = new Harness(text -> "friend".equals(text) ? "amigo" : "Hola")) {
      assertAccepted(harness.run(source, false, BEFORE, AFTER),
          "Hola\t" + EMOJI + "\t amigo\r\nHola" + SPARKLES + "\tamigo");
    }
  }

  @Test public void badSecondProsePieceCannotAcceptOrCheckpointPartialRecovery() throws Exception {
    String source = "Hello " + EMOJI + " friend";
    for (String bad : List.of("", "friend", "\u4f60\u597d")) {
      try (Harness harness = new Harness(text -> "friend".equals(text) ? bad : "Hola")) {
        Delivery failed = harness.run(source, false, BEFORE, AFTER);
        assertRejected(cue(failed.result));
        assertRejected(cue(failed.batch));
        int calls = harness.prompts.size();
        Delivery resumed = harness.run(source, true, BEFORE, AFTER);
        assertTrue("Partial prose cannot satisfy resume", harness.prompts.size() > calls);
        assertRejected(cue(resumed.result));
        assertRejected(cue(resumed.batch));
      }
    }
  }

  @Test public void invalidRecoveryIdCannotAcceptOrCheckpointPartialRecovery() throws Exception {
    try (Harness harness = new Harness(text -> "friend".equals(text) ? "amigo" : "Hola")) {
      harness.invalidIdSource = "friend";
      String source = "Hello " + EMOJI + " friend";
      Delivery failed = harness.run(source, false, BEFORE, AFTER);
      assertRejected(cue(failed.result));
      assertRejected(cue(failed.batch));
      int calls = harness.prompts.size();
      Delivery resumed = harness.run(source, true, BEFORE, AFTER);
      assertTrue(harness.prompts.size() > calls);
      assertRejected(cue(resumed.result));
      assertRejected(cue(resumed.batch));
    }
  }

  @Test public void cancellationAfterSecondProseGenerationCannotCommitRecovery() throws Exception {
    String source = "Hello " + EMOJI + " friend";
    try (Harness harness = new Harness(text -> "friend".equals(text) ? "amigo" : "Hola")) {
      harness.cancelSource = "friend";
      harness.run(source, false, BEFORE, AFTER, true);
      assertTrue("Cancelled recovery must not reach the accepted-batch channel",
          harness.translator.getAcceptedBatches("mixed-literal-request").isEmpty());
      int calls = harness.prompts.size();
      assertAccepted(harness.run(source, true, BEFORE, AFTER), "Hola " + EMOJI + " amigo");
      assertTrue("Cancelled recovery cannot provide a checkpoint", harness.prompts.size() > calls);
      assertTrue("Resume must regenerate the first prose piece too",
          harness.prompts.subList(calls, harness.prompts.size()).stream().anyMatch(prompt ->
              "Hello".equals(prompt.getAsJsonArray("captions").get(0)
                  .getAsJsonObject().get("text").getAsString())));
    }
  }

  @Test public void lineBreakOnlyMismatchKeepsOrdinaryWholeCueRepair() throws Exception {
    try (Harness harness = new Harness("Hola\namigo")) {
      harness.omitFirstLineBreak = true;
      assertAccepted(harness.run("Hello\nfriend", false, BEFORE, AFTER), "Hola\namigo");
      assertTrue(harness.prompts.size() > 1);
      for (JsonObject prompt : harness.prompts) {
        assertEquals("Hello\nfriend", prompt.getAsJsonArray("captions").get(0)
            .getAsJsonObject().get("text").getAsString());
      }
    }
  }

  private void expectPreserved(String source, String expected) throws Exception {
    try (Harness harness = new Harness("Hola")) {
      assertAccepted(harness.run(source, false, BEFORE, AFTER), expected);
      assertFalse("No inference means the test did not exercise mixed prose", harness.prompts.isEmpty());
    }
  }

  private static void assertAccepted(Delivery delivery, String expected) {
    for (Map<?, ?> cue : List.of(cue(delivery.result), cue(delivery.batch))) {
      assertEquals("Valid Spanish prose must survive with exact source literals; actual cue: " + cue,
          Boolean.TRUE, cue.get("valid"));
      assertEquals("Exact text checks ordering, multiplicity, joins, skin tone and ZWJ",
          expected, cue.get("text"));
      assertFalse("Accepted output must not carry a failure", cue.containsKey("failureReason"));
    }
  }

  private static void assertRejected(Map<?, ?> cue) {
    assertEquals(Boolean.FALSE, cue.get("valid"));
    assertEquals("Failed prose must not leak literals, partial output, or prior saved text", "", cue.get("text"));
    assertNotNull("A rejection needs a caller-visible reason", cue.get("failureReason"));
  }

  private static Map<?, ?> cue(Map<String, Object> envelope) {
    List<?> captions = (List<?>) envelope.get("captions");
    assertEquals(1, captions.size());
    Map<?, ?> cue = (Map<?, ?>) captions.get(0);
    assertEquals("source", cue.get("id"));
    return cue;
  }

  private static final class Delivery {
    final Map<String, Object> result;
    final Map<String, Object> batch;

    Delivery(Map<String, Object> result, Map<String, Object> batch) {
      this.result = result;
      this.batch = batch;
    }
  }

  private final class Harness implements AutoCloseable {
    final List<JsonObject> prompts = new ArrayList<>();
    final File model;
    final NaturalCaptionTranslator translator;
    boolean missingResponse;
    boolean omitFirstLineBreak;
    String invalidIdSource;
    String cancelSource;

    Harness(String simulatedModelText) throws Exception {
      this(text -> simulatedModelText);
    }

    Harness(Function<String, String> simulatedModelText) throws Exception {
      model = Files.createTempFile(temporary.getRoot().toPath(), "mixed-model-", ".litertlm").toFile();
      Files.write(model.toPath(), new byte[] {1});
      File cache = temporary.newFolder();
      File checkpoints = temporary.newFolder();
      TranslationRuntimeFactory factory = (file, folder, threads, instruction) -> new TranslationRuntime() {
        public boolean supportsStructuredOutput() { return true; }
        public String translate(String prompt) { throw new AssertionError("Request settings were lost"); }
        public String translate(String prompt, int tokens, boolean structured) {
          assertTrue("Exercise the normal structured-output path", structured);
          JsonObject input = JsonParser.parseString(prompt).getAsJsonObject();
          prompts.add(input);
          JsonArray output = new JsonArray();
          // IDs follow the actual request, including any future fragment IDs.
          // The only supplied translation is the simulated model text. No fake
          // copies source literals, rewrites output, or implements the repair.
          if (!missingResponse) {
            for (var element : input.getAsJsonArray("captions")) {
              String source = element.getAsJsonObject().get("text").getAsString();
              JsonObject item = new JsonObject();
              item.addProperty("id", source.equals(invalidIdSource) ? "wrong-id"
                  : element.getAsJsonObject().get("id").getAsString());
              String text = simulatedModelText.apply(source);
              item.addProperty("text", omitFirstLineBreak && prompts.size() == 1
                  ? text.replace("\n", " ") : text);
              output.add(item);
              if (source.equals(cancelSource)) {
                cancelSource = null;
                cancelGeneration();
              }
            }
          }
          return output.toString();
        }
        public void cancel() {}
        public void close() {}
      };
      translator = new NaturalCaptionTranslator(new TranslationEnvironment() {
        public File prepareCacheDirectory() { return cache; }
        public File prepareCheckpointDirectory() { return checkpoints; }
        public void verifyDeviceCapacity(File file) {}
      }, factory, (file, cancelled, progress) -> {}, Executors.newSingleThreadExecutor(), line -> {});
    }

    Delivery run(String source, boolean reuse, String before, String after) throws Exception {
      return run(source, reuse, before, after, false);
    }

    void cancelGeneration() { translator.cancel(); }

    Delivery run(String source, boolean reuse, String before, String after, boolean expectCancellation) throws Exception {
      CountDownLatch done = new CountDownLatch(1);
      AtomicReference<Map<String, Object>> result = new AtomicReference<>();
      AtomicReference<Map<String, Object>> batch = new AtomicReference<>();
      AtomicReference<String> error = new AtomicReference<>();
      translator.start(model.getAbsolutePath(), Map.of(
          "requestId", "mixed-literal-request", "runtimeBackend", "cpu",
          "reuseCheckpoints", reuse, "repairUnusableOutputs", true,
          "operations", List.of(Map.of("id", "operation", "sourceLanguage", "en", "targetLanguage", "es",
              "batches", List.of(Map.of("captions", List.of(Map.of("id", "source", "text", source)),
                  "contextBefore", before, "contextAfter", after))))), new NaturalCaptionTranslator.Callback() {
        public void onBatchAccepted(Map<String, Object> value) { batch.set(value); }
        public void onSuccess(Map<String, Object> value) { result.set(value); done.countDown(); }
        public void onError(String code, String message, Throwable cause) {
          error.set(code + ": " + message + "; cause=" + cause);
          done.countDown();
        }
      });
      assertTrue("Translator callback timed out", done.await(10, TimeUnit.SECONDS));
      if (expectCancellation) {
        assertNotNull("Recovery must report cancellation", error.get());
        assertTrue(error.get(), error.get().startsWith(NaturalCaptionTranslator.CANCELLED + ":"));
        assertNull("Cancellation cannot deliver success", result.get());
        assertNull("Cancellation cannot deliver a partial batch", batch.get());
        return null;
      }
      assertNull("A harness/runtime error is not the expected acceptance failure", error.get());
      assertNotNull("Missing terminal success envelope", result.get());
      assertNotNull("The caller's accepted-batch channel must also be exercised", batch.get());
      return new Delivery(result.get(), batch.get());
    }

    public void close() { translator.close(); }
  }
}
