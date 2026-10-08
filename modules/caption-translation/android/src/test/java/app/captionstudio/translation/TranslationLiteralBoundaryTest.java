package app.captionstudio.translation;

import static org.junit.Assert.*;
import com.google.gson.*;
import java.io.File;
import java.io.InputStreamReader;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class TranslationLiteralBoundaryTest {
  @Rule public TemporaryFolder temporary = new TemporaryFolder();

  private static String response(String id, String text) {
    JsonObject item = new JsonObject(); item.addProperty("id", id); item.addProperty("text", text);
    JsonArray array = new JsonArray(); array.add(item); return array.toString();
  }

  @Test public void sourceChatMarkersRemainLiteralInInitialAndRetryResponses() throws Exception {
    JsonObject fixture = JsonParser.parseReader(new InputStreamReader(
        getClass().getResourceAsStream("/translation-prompt-markers.json"),
        StandardCharsets.UTF_8)).getAsJsonObject();
    for (JsonElement entry : fixture.getAsJsonArray("added_tokens")) {
      String marker = entry.getAsString();
      if (!marker.startsWith("<|")) continue;
      assertPreserved(marker);
    }
    assertPreserved("<|future_token|>");
    assertPreserved("<|unfinished");
    assertPreserved("<|");
  }

  private static void assertPreserved(String marker) throws Exception {
    var source = new NaturalCaptionTranslator.Caption("c1", "Keep " + marker + " literal.");
    String output = "Conserva " + marker + " literal.";
    var initial = NaturalCaptionTranslator.parseStrictResponse(response("c1", output), List.of(source)).get(0);
    assertTrue(marker, initial.valid);
    assertEquals(output, initial.text);
    var retry = NaturalCaptionTranslator.parseSingleCaptionRetryResponse(response("c1", output), source);
    assertTrue(marker, retry.valid);
    assertEquals(output, retry.text);
  }

  @Test public void markersCannotBeIntroducedReplacedDuplicatedOrDropped() throws Exception {
    var source = new NaturalCaptionTranslator.Caption("c1", "Keep <|im_start|> literal.");
    for (String output : List.of("Conserva <|im_end|> literal.",
        "Conserva <|im_start|><|im_start|> literal.", "Conserva literal.",
        "Conserva <|im_start|> <|extra|> literal.")) {
      assertFalse(output, NaturalCaptionTranslator.parseStrictResponse(
          response("c1", output), List.of(source)).get(0).valid);
      assertFalse(output, NaturalCaptionTranslator.parseSingleCaptionRetryResponse(
          response("c1", output), source).valid);
    }
    var ordinary = new NaturalCaptionTranslator.Caption("c1", "Keep this literal.");
    assertFalse(NaturalCaptionTranslator.parseStrictResponse(
        response("c1", "Conserva <|im_start|> literal."), List.of(ordinary)).get(0).valid);
  }

  @Test public void literalMarkersAreNotBrokenByProtectedFragmentSplitting() {
    String source = "Keep <|im_start|> here and <|future_token|> there.";
    List<String> fragments = TranslationPreservation.split(source, 18);
    assertEquals(source, String.join("", fragments));
    for (String marker : List.of("<|im_start|>", "<|future_token|>")) {
      assertEquals(marker, 1, fragments.stream().filter(part -> part.contains(marker)).count());
    }
  }

  @Test public void ordinaryComparisonBytesDoNotCauseExtraFragments() {
    String source = "x < y > z ".repeat(30);
    assertEquals(List.of(source), TranslationText.split(source));
    assertEquals(List.of(source), TranslationPreservation.split(source, 480));
  }

  @Test public void ordinaryContextUsesItsActualSerializedByteBudget() throws Exception {
    Method bounded = NaturalCaptionTranslator.class.getDeclaredMethod("boundedContext", String.class, boolean.class);
    bounded.setAccessible(true);
    String source = "< > ".repeat(40);
    assertEquals(source.substring(0, 128), bounded.invoke(null, source, false));
    assertEquals(source.substring(source.length() - 128), bounded.invoke(null, source, true));
  }

  @Test public void acceptedCodeMarkerRestoresAfterWorkerRecreationWithoutInference() throws Exception {
    exerciseCheckpoint(false);
  }

  @Test public void codeMarkerRepairAndCheckpointRestoreUseTheSameAcceptancePolicy() throws Exception {
    exerciseCheckpoint(true);
  }

  private void exerciseCheckpoint(boolean firstReject) throws Exception {
    File model = temporary.newFile("model.litertlm");
    Files.write(model.toPath(), new byte[] {1});
    File cache = temporary.newFolder(), checkpoints = temporary.newFolder();
    AtomicInteger calls = new AtomicInteger();
    String source = "Keep " + '\u0060' + "<|im_start|>" + '\u0060' + " literal.";
    String translated = "Conserva " + '\u0060' + "<|im_start|>" + '\u0060' + " literal.";
    var request = Map.<String, Object>of("reuseCheckpoints", true, "repairUnusableOutputs", true,
        "operations", List.of(Map.of("id", "operation", "sourceLanguage", "en", "targetLanguage", "es",
            "batches", List.of(Map.of("captions", List.of(Map.of("id", "c1", "text", source)))))));
    TranslationRuntimeFactory factory = (file, folder, threads, instruction) -> new TranslationRuntime() {
      public String translate(String prompt) {
        if (calls.incrementAndGet() == 1 && firstReject) return "[]";
        JsonArray input = JsonParser.parseString(prompt).getAsJsonObject().getAsJsonArray("captions");
        String id = input.get(0).getAsJsonObject().get("id").getAsString();
        return response(id, translated);
      }
      public void cancel() {}
      public void close() {}
    };
    try (NaturalCaptionTranslator worker = worker(cache, checkpoints, factory)) {
      Map<?, ?> cue = run(worker, model, request);
      assertEquals(true, cue.get("valid"));
      assertEquals(translated, cue.get("text"));
    }
    int afterFirst = calls.get();
    assertEquals(firstReject ? 2 : 1, afterFirst);
    try (NaturalCaptionTranslator worker = worker(cache, checkpoints, factory)) {
      assertEquals(translated, run(worker, model, request).get("text"));
      assertEquals(afterFirst, calls.get());
    }
  }

  private static NaturalCaptionTranslator worker(File cache, File checkpoints, TranslationRuntimeFactory factory) {
    return new NaturalCaptionTranslator(new TranslationEnvironment() {
      public File prepareCacheDirectory() { return cache; }
      public File prepareCheckpointDirectory() { return checkpoints; }
      public void verifyDeviceCapacity(File model) {}
    }, factory, (model, cancelled, progress) -> {}, Executors.newSingleThreadExecutor());
  }

  private static Map<?, ?> run(NaturalCaptionTranslator worker, File model, Map<String, Object> request) throws Exception {
    CountDownLatch done = new CountDownLatch(1);
    AtomicReference<Map<String, Object>> result = new AtomicReference<>();
    AtomicReference<String> failure = new AtomicReference<>();
    worker.start(model.getAbsolutePath(), request, new NaturalCaptionTranslator.Callback() {
      public void onSuccess(Map<String, Object> value) { result.set(value); done.countDown(); }
      public void onError(String code, String message, Throwable cause) { failure.set(code); done.countDown(); }
    });
    assertTrue("Worker did not finish", done.await(10, TimeUnit.SECONDS));
    assertNull(failure.get());
    return (Map<?, ?>) ((List<?>) result.get().get("captions")).get(0);
  }
}
