package app.captionstudio.translation;

import static org.junit.Assert.*;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.File;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class TranslationTruncationRecoveryTest {
  @Rule public TemporaryFolder temporary = new TemporaryFolder();
  private static final String SOURCE = "Please keep this app blank.";
  private static final String TRANSLATED = "\u064a\u0631\u062c\u0649 \u0625\u0628\u0642\u0627\u0621 \u0647\u0630\u0627 \u0627\u0644\u062a\u0637\u0628\u064a\u0642 \u0641\u0627\u0631\u063a\u0627\u064b.";
  private static final String EOF = "[{\"id\":\"cue\",\"text\":\"" + TRANSLATED;

  @Test public void initialAndRepairGenerationReceiveOnlyTheRequestedCueSchema() throws Exception {
    FakeRuntime runtime = new FakeRuntime(valid("cue", TRANSLATED), valid("cue", TRANSLATED), "cap");
    try (Fixture fixture = new Fixture(runtime, SOURCE, "Before", "After")) {
      assertEquals(true, fixture.run().get("valid"));
      assertEquals(2, runtime.schemas.size());
      for (String encoded : runtime.schemas) {
        JsonObject schema = JsonParser.parseString(encoded).getAsJsonObject();
        assertEquals(1, schema.get("minItems").getAsInt());
        assertEquals(1, schema.get("maxItems").getAsInt());
        JsonObject properties = schema.getAsJsonObject("items").getAsJsonObject("properties");
        assertEquals("cue", properties.getAsJsonObject("id").getAsJsonArray("enum").get(0).getAsString());
        assertEquals(1, properties.getAsJsonObject("text").get("minLength").getAsInt());
        assertFalse(encoded.contains(SOURCE));
      }
    }
  }

  @Test public void secondObservedTruncationGetsOneLargerRepairAndCachesOnlyCompleteText() throws Exception {
    FakeRuntime runtime = new FakeRuntime(EOF, valid("cue", TRANSLATED), "cap");
    try (Fixture fixture = new Fixture(runtime, SOURCE, "Before", "After")) {
      Map<?, ?> result = fixture.run();
      assertEquals("A capped EOF in the first repair must get one bounded recovery", true, result.get("valid"));
      assertEquals(TRANSLATED, result.get("text"));
      assertEquals(3, runtime.tokens.size());
      int previous = runtime.tokens.get(1), expanded = runtime.tokens.get(2);
      assertTrue(expanded >= previous + Math.max(64, previous / 2));
      assertTrue(expanded <= 1024);
      assertEquals(runtime.prompts.get(1), runtime.prompts.get(2));
      assertTrue(fits(runtime.prompts.get(2), expanded));
      JsonObject repair = JsonParser.parseString(runtime.prompts.get(2)).getAsJsonObject();
      assertEquals("Before", repair.get("contextBefore").getAsString());
      assertEquals("After", repair.get("contextAfter").getAsString());
      assertEquals("Before", repair.getAsJsonObject("sourceNeighbors").get("before").getAsString());
      assertEquals("After", repair.getAsJsonObject("sourceNeighbors").get("after").getAsString());
      assertEquals("cue", repair.getAsJsonArray("captions").get(0).getAsJsonObject().get("id").getAsString());
      assertEquals(true, fixture.run().get("valid"));
      assertEquals("Only complete accepted text may be restored", 3, runtime.tokens.size());
    }
  }

  @Test public void missingBelowCapInvalidOrFlagOnlyMetricsNeverAuthorizeExtraRepair() throws Exception {
    for (String evidence : List.of("missing", "below", "nan", "negative", "flag", "throws")) {
      FakeRuntime runtime = new FakeRuntime(EOF, valid("cue", TRANSLATED), evidence);
      try (Fixture fixture = new Fixture(runtime, SOURCE, "Before", "After")) {
        assertRejected(fixture.run());
        assertEquals(evidence, 2, runtime.tokens.size());
      }
    }
  }

  @Test public void syntaxEchoAndWrongIdAtCapDoNotAuthorizeExtraRepair() throws Exception {
    for (String response : List.of("[{!", valid("cue", SOURCE), valid("other", TRANSLATED))) {
      FakeRuntime runtime = new FakeRuntime(response, valid("cue", TRANSLATED), "cap");
      try (Fixture fixture = new Fixture(runtime, SOURCE, "Before", "After")) {
        assertRejected(fixture.run());
        assertEquals(2, runtime.tokens.size());
      }
    }
  }

  @Test public void thirdTruncationStopsAndNeverCachesPartialText() throws Exception {
    FakeRuntime runtime = new FakeRuntime(EOF, EOF, "cap");
    try (Fixture fixture = new Fixture(runtime, SOURCE, "Before", "After")) {
      assertRejected(fixture.run());
      assertEquals(3, runtime.tokens.size());
      assertRejected(fixture.run());
      assertEquals("Rejected fragments must be generated again", 6, runtime.tokens.size());
    }
  }

  @Test public void additionalRepairStillRejectsSyntaxWrongIdEchoAndTrailingContent() throws Exception {
    for (String response : List.of("[{!", valid("other", TRANSLATED), valid("cue", SOURCE),
        valid("cue", TRANSLATED) + " extra")) {
      FakeRuntime runtime = new FakeRuntime(EOF, response, "cap");
      try (Fixture fixture = new Fixture(runtime, SOURCE, "Before", "After")) {
        assertRejected(fixture.run());
        assertEquals(3, runtime.tokens.size());
      }
    }
  }

  @Test public void outputCeilingPreventsExtraGeneration() throws Exception {
    FakeRuntime runtime = new FakeRuntime(EOF, valid("cue", TRANSLATED), "cap");
    try (Fixture fixture = new Fixture(runtime, "Please ".repeat(40), "Before", "After")) {
      assertRejected(fixture.run());
      assertEquals(2, runtime.tokens.size());
      assertEquals(Integer.valueOf(1024), runtime.tokens.get(1));
    }
  }

  @Test public void contextCapacityPreventsExpansionWithoutDroppingNeighbors() throws Exception {
    String context = "<".repeat(32);
    String source = null;
    for (int length = 20; length <= 78; length++) {
      String candidate = "Please " + "<".repeat(length);
      var request = new NaturalCaptionTranslator.ValidatedRequest("en", "ar",
          List.of(new NaturalCaptionTranslator.Caption("cue", candidate)), context, context);
      JsonObject prompt = JsonParser.parseString(NaturalCaptionTranslator.buildRetryPrompt(request, 0)).getAsJsonObject();
      prompt.getAsJsonObject("repair").addProperty("reason", "MALFORMED_JSON");
      JsonObject neighbors = new JsonObject();
      neighbors.addProperty("before", context); neighbors.addProperty("after", context);
      prompt.add("sourceNeighbors", neighbors);
      int base = NaturalCaptionTranslator.outputTokenLimit(candidate, true);
      int first = Math.min(1024, base + Math.max(32, base / 4));
      int larger = first + Math.max(64, first / 2);
      String encoded = prompt.toString().replace("<", "\\u003c").replace(">", "\\u003e");
      if (larger <= 1024 && fits(encoded, first) && !fits(encoded, larger)) {
        source = candidate; break;
      }
    }
    assertNotNull("Need a fragment whose existing repair fits but expansion does not", source);
    FakeRuntime runtime = new FakeRuntime(EOF, valid("cue", TRANSLATED), "cap");
    try (Fixture fixture = new Fixture(runtime, source, context, context)) {
      assertRejected(fixture.run());
      assertEquals(2, runtime.tokens.size());
      String prompt = runtime.prompts.get(1);
      int first = runtime.tokens.get(1);
      assertTrue(fits(prompt, first));
      assertFalse(fits(prompt, first + Math.max(64, first / 2)));
      assertEquals(context, JsonParser.parseString(prompt).getAsJsonObject()
          .getAsJsonObject("sourceNeighbors").get("before").getAsString());
    }
  }

  private static boolean fits(String prompt, int tokens) throws Exception {
    Method method = NaturalCaptionTranslator.class.getDeclaredMethod("fitsPromptCapacity", String.class, int.class);
    method.setAccessible(true);
    return (Boolean) method.invoke(null, prompt, tokens);
  }

  private static String valid(String id, String text) {
    JsonObject item = new JsonObject(); item.addProperty("id", id); item.addProperty("text", text);
    return "[" + item + "]";
  }

  private static void assertRejected(Map<?, ?> cue) {
    assertEquals(false, cue.get("valid"));
    assertEquals("", cue.get("text"));
  }

  private static final class FakeRuntime implements TranslationRuntime {
    final List<Integer> tokens = new ArrayList<>();
    final List<String> prompts = new ArrayList<>();
    final List<String> schemas = new ArrayList<>();
    final String repairResponse, extraResponse, evidence;
    int callInRun;
    FakeRuntime(String repairResponse, String extraResponse, String evidence) {
      this.repairResponse = repairResponse; this.extraResponse = extraResponse; this.evidence = evidence;
    }
    public boolean supportsStructuredOutput() { return true; }
    public String translate(String prompt) { throw new AssertionError("Lost generation settings"); }
    public String translate(String prompt, int limit, boolean structured) {
      assertTrue(structured); tokens.add(limit); prompts.add(prompt); callInRun++;
      return callInRun == 1 ? EOF : callInRun == 2 ? repairResponse : extraResponse;
    }
    public String translate(String prompt, int limit, boolean structured, String schema) {
      assertTrue(structured);
      schemas.add(schema);
      return translate(prompt, limit, structured);
    }
    public Map<String, Object> lastGenerationDiagnostics() {
      int limit = tokens.get(tokens.size() - 1);
      if (callInRun == 1 || evidence.equals("cap")) return Map.of("decodeTokenCount", limit);
      switch (evidence) {
        case "below": return Map.of("decodeTokenCount", limit - 1);
        case "nan": return Map.of("decodeTokenCount", Double.NaN);
        case "negative": return Map.of("decodeTokenCount", -1);
        case "flag": return Map.of("outputTokenLimitHit", true);
        case "throws": throw new IllegalStateException("Unavailable metrics");
        default: return Map.of();
      }
    }
    public void cancel() {}
    public void close() {}
  }

  private final class Fixture implements AutoCloseable {
    final FakeRuntime runtime;
    final NaturalCaptionTranslator translator;
    final File model;
    final Map<String, Object> request;
    Fixture(FakeRuntime runtime, String source, String before, String after) throws Exception {
      this.runtime = runtime;
      model = temporary.newFile("model-" + System.nanoTime() + ".litertlm");
      Files.write(model.toPath(), new byte[] {1});
      File cache = temporary.newFolder(), checkpoints = temporary.newFolder();
      translator = new NaturalCaptionTranslator(new TranslationEnvironment() {
        public File prepareCacheDirectory() { return cache; }
        public File prepareCheckpointDirectory() { return checkpoints; }
        public void verifyDeviceCapacity(File file) {}
      }, (file, folder, threads, instruction) -> runtime, (file, cancelled, progress) -> {},
          Executors.newSingleThreadExecutor(), line -> {});
      request = Map.of("reuseCheckpoints", true, "repairUnusableOutputs", true,
          "operations", List.of(Map.of("id", "op", "sourceLanguage", "en", "targetLanguage", "ar",
              "batches", List.of(Map.of("captions", List.of(Map.of("id", "cue", "text", source)),
                  "contextBefore", before, "contextAfter", after)))));
    }
    Map<?, ?> run() throws Exception {
      runtime.callInRun = 0;
      CountDownLatch done = new CountDownLatch(1);
      AtomicReference<Map<String, Object>> result = new AtomicReference<>();
      AtomicReference<String> failure = new AtomicReference<>();
      translator.start(model.getAbsolutePath(), request, new NaturalCaptionTranslator.Callback() {
        public void onSuccess(Map<String, Object> value) { result.set(value); done.countDown(); }
        public void onError(String code, String message, Throwable cause) { failure.set(code + ": " + message); done.countDown(); }
      });
      assertTrue(done.await(10, TimeUnit.SECONDS)); assertNull(failure.get());
      return (Map<?, ?>) ((List<?>) result.get().get("captions")).get(0);
    }
    public void close() { translator.close(); }
  }
}
