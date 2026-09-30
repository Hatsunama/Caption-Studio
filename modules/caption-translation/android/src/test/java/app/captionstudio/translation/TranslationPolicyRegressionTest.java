package app.captionstudio.translation;

import static org.junit.Assert.*;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class TranslationPolicyRegressionTest {
  @Rule public TemporaryFolder temporary = new TemporaryFolder();

  @Test public void refreshWritesReplacementThatResumeReadsWithoutGeneration() throws Exception {
    try (Fixture f = new Fixture()) {
      var captions = List.of(caption("cue", "Hello"));
      run(f, request(captions, true));
      f.output = "\u60a8\u597d";
      run(f, request(captions, false));
      assertEquals(2, f.prompts.size());
      assertEquals("\u60a8\u597d", resultCue(run(f, request(captions, true)), 0).get("text"));
      assertEquals("Resume must read the refreshed checkpoint", 2, f.prompts.size());
    }
  }

  @Test public void distantTransportChangesAndMovedBatchReuseActualCueContext() throws Exception {
    try (Fixture f = new Fixture()) {
      var first = List.of(caption("far", "Distant old"), caption("near", "N".repeat(128)),
          caption("cue", "Hello"), caption("after", "A".repeat(128)));
      run(f, request(first, true));
      f.prompts.clear();
      var changed = List.of(caption("renamed-far", "Distant changed"), caption("renamed-near", "N".repeat(128)),
          caption("renamed-cue", "Hello"), caption("renamed-after", "A".repeat(128)));
      run(f, request(changed, true));
      for (String prompt : f.prompts) for (var item : JsonParser.parseString(prompt).getAsJsonObject().getAsJsonArray("captions"))
        assertNotEquals("An unrelated distant cue must not invalidate this checkpoint", "Hello", item.getAsJsonObject().get("text").getAsString());
      f.prompts.clear();
      var moved = request(changed, true);
      moved.put("operations", List.of(Map.of("id", "renamed-operation", "sourceLanguage", "en", "targetLanguage", "zh-Hans",
          "batches", List.of(Map.of("captions", List.of(caption("literal", "42"))), batch(changed)))));
      run(f, moved);
      assertTrue("Moving transport batch position must reuse all cues", f.prompts.isEmpty());
    }
  }

  @Test public void changedImmediateNeighborInvalidatesCue() throws Exception {
    try (Fixture f = new Fixture()) {
      run(f, request(List.of(caption("before", "Previous"), caption("cue", "Hello")), true));
      f.prompts.clear();
      run(f, request(List.of(caption("before", "Changed previous"), caption("cue", "Hello")), true));
      assertTrue(f.prompts.stream().anyMatch(p -> p.contains("Hello")));
    }
  }

  @Test public void fragmentCheckpointsIgnoreTransportIdLength() throws Exception {
    try (Fixture f = new Fixture()) {
      String source = "Hello " + "please ".repeat(120);
      var first = run(f, request(List.of(caption("short", source)), true));
      int calls = f.prompts.size();
      var renamed = run(f, request(List.of(caption("x".repeat(64), source)), true));
      assertEquals(Boolean.TRUE, resultCue(first, 0).get("valid"));
      assertEquals(resultCue(first, 0).get("text"), resultCue(renamed, 0).get("text"));
      assertEquals(calls, f.prompts.size());
    }
  }

  @Test public void oversizedNeighborsSurviveInitialAndRepairWithinConservativeCapacity() throws Exception {
    try (Fixture f = new Fixture()) {
      f.rejectInitial = true;
      var result = run(f, request(List.of(caption("before", "<".repeat(128)),
          caption("cue", "Hello " + "please ".repeat(80)), caption("after", ">".repeat(128))), false));
      assertEquals(Boolean.TRUE, resultCue(result, 1).get("valid"));
      assertTrue(f.prompts.size() <= 2 * 16);
      StringBuilder source = new StringBuilder();
      for (String prompt : f.prompts) {
        JsonObject input = JsonParser.parseString(prompt).getAsJsonObject();
        assertNotNull("Immediate source neighbors must survive capacity pressure", input.getAsJsonObject("sourceNeighbors"));
        assertFalse(input.getAsJsonObject("sourceNeighbors").get("before").getAsString().isEmpty());
        assertFalse(input.getAsJsonObject("sourceNeighbors").get("after").getAsString().isEmpty());
        if (!input.has("retry")) for (var item : input.getAsJsonArray("captions")) source.append(item.getAsJsonObject().get("text").getAsString());
      }
      assertEquals("Hello " + "please ".repeat(80), source.toString());
    }
  }

  @Test public void sameScriptRetryCarriesExactDirectionAndReadOnlyNeighbors() throws Exception {
    for (String[] direction : List.of(new String[] { "de", "es", "German (de)", "Spanish (es)", "hola mundo" },
        new String[] { "ur", "ar", "Urdu (ur)", "Arabic (ar)", "\u0645\u0631\u062d\u0628\u0627" })) {
      try (Fixture f = new Fixture()) {
        f.initialResponse = "[]"; f.output = direction[4];
        Map<String, Object> input = request(List.of(caption("cue", "Hallo Welt")), false);
        input.put("operations", List.of(Map.of("id", "direction", "sourceLanguage", direction[0], "targetLanguage", direction[1],
            "batches", List.of(Map.of("captions", List.of(caption("cue", "Hallo Welt")), "contextBefore", "Previous source", "contextAfter", "Next source")))));
        run(f, input);
        JsonObject retry = JsonParser.parseString(f.prompts.get(1)).getAsJsonObject();
        assertEquals(direction[2], retry.get("sourceLanguage").getAsString());
        assertEquals(direction[3], retry.get("targetLanguage").getAsString());
        assertTrue(retry.getAsJsonObject("repair").get("guidance").getAsString().contains(direction[2]));
        assertTrue(retry.getAsJsonObject("repair").get("guidance").getAsString().contains(direction[3]));
        assertEquals("Hallo Welt", retry.getAsJsonArray("captions").get(0).getAsJsonObject().get("text").getAsString());
        assertEquals("Previous source", retry.getAsJsonObject("sourceNeighbors").get("before").getAsString());
        assertEquals("Next source", retry.getAsJsonObject("sourceNeighbors").get("after").getAsString());
      }
    }
  }

  @Test public void outputCapExpandsOnlyWithNumericEvidenceAndWithinCapacity() throws Exception {
    for (boolean hit : new boolean[] { false, true }) {
      try (Fixture f = new Fixture()) {
        f.initialResponse = "[]"; f.reportCapHit = hit;
        run(f, request(List.of(caption("cue", "Hello")), false));
        assertEquals(2, f.tokenLimits.size());
        int establishedRepairLimit = NaturalCaptionTranslator.outputTokenLimit("Hello", true);
        if (hit) assertTrue(f.tokenLimits.get(1) > establishedRepairLimit);
        else assertEquals(establishedRepairLimit, (int) f.tokenLimits.get(1));
      }
    }
  }

  @Test public void benchmarkNeitherReadsNorReplacesNormalCheckpoint() throws Exception {
    try (Fixture f = new Fixture()) {
      var input = request(List.of(caption("cue", "Hello")), true);
      run(f, input); f.output = "\u60a8\u597d";
      var benchmark = new LinkedHashMap<>(input); benchmark.put("benchmarkNoCheckpoints", true);
      run(f, benchmark);
      assertEquals("\u4f60\u597d", resultCue(run(f, input), 0).get("text"));
      assertEquals(2, f.prompts.size());
    }
  }

  @Test public void preciseParserReasonsReachRepairAndMalformedSubtypeIsPrivate() throws Exception {
    for (String malformed : List.of("[{\"id\":\"cue\",\"text\":\"", "[{\"id\":\"cue\",\"text\":!}]",
        "[{\"id\":\"cue\",\"text\":\"ok\"} {\"id\":\"cue\",\"text\":\"ok\"}]")) {
      try (Fixture f = new Fixture()) {
        f.initialResponse = malformed;
        run(f, request(List.of(caption("cue", "Hello")), false));
        JsonObject retry = JsonParser.parseString(f.prompts.get(1)).getAsJsonObject();
        assertEquals("MALFORMED_JSON", retry.getAsJsonObject("repair").get("reason").getAsString());
        String subtype = malformed.endsWith("\"") ? "UNEXPECTED_EOF" : "SYNTAX";
        assertTrue(f.logs.toString(), f.logs.stream().anyMatch(s -> s.contains("malformedKind=" + subtype)));
        assertTrue(f.logs.stream().anyMatch(s -> s.contains("decodeTokenCount=17")));
        for (String log : f.logs) { assertFalse(log.contains("Hello")); assertFalse(log.contains("cue")); assertFalse(log.contains("private-path")); }
      }
    }
    try (Fixture f = new Fixture()) {
      f.initialResponse = "[{\"id\":\"two\",\"text\":\"\u4f60\u597d\"},{\"id\":\"one\",\"text\":\"\u4f60\u597d\"}]";
      run(f, request(List.of(caption("one", "Hello"), caption("two", "World")), false));
      assertEquals(3, f.prompts.size());
      for (int i = 1; i < 3; i++) assertEquals("ID_ORDER", JsonParser.parseString(f.prompts.get(i)).getAsJsonObject().getAsJsonObject("repair").get("reason").getAsString());
    }
  }

  private static Map<String, String> caption(String id, String text) { return Map.of("id", id, "text", text); }
  private static Map<String, Object> batch(List<Map<String, String>> captions) { return Map.of("captions", captions); }
  private static Map<String, Object> request(List<Map<String, String>> captions, boolean reuse) {
    Map<String, Object> request = new LinkedHashMap<>();
    request.put("reuseCheckpoints", reuse); request.put("repairUnusableOutputs", true);
    request.put("operations", List.of(Map.of("id", "operation", "sourceLanguage", "en", "targetLanguage", "zh-Hans", "batches", List.of(batch(captions)))));
    return request;
  }
  @SuppressWarnings("unchecked") private static Map<String, Object> resultCue(Map<String, Object> result, int index) {
    return ((List<Map<String, Object>>) result.get("captions")).get(index);
  }
  private static Map<String, Object> run(Fixture f, Map<String, Object> request) throws Exception {
    CountDownLatch done = new CountDownLatch(1);
    AtomicReference<Map<String, Object>> result = new AtomicReference<>();
    AtomicReference<String> error = new AtomicReference<>();
    f.translator.start(f.model.getAbsolutePath(), request, new NaturalCaptionTranslator.Callback() {
      public void onSuccess(Map<String, Object> value) { result.set(value); done.countDown(); }
      public void onError(String code, String message, Throwable cause) { error.set(code + ": " + message); done.countDown(); }
    });
    assertTrue(done.await(10, TimeUnit.SECONDS)); assertNull(error.get()); return result.get();
  }
  private final class Fixture implements AutoCloseable {
    final File model;
    final List<String> prompts = new ArrayList<>(), logs = new ArrayList<>();
    final List<Integer> tokenLimits = new ArrayList<>();
    final NaturalCaptionTranslator translator;
    String output = "\u4f60\u597d", initialResponse;
    boolean rejectInitial, reportCapHit;
    String systemInstruction;
    int lastTokens;
    Fixture() throws Exception {
      model = new File(temporary.newFolder(), "model.litertlm");
      Files.write(model.toPath(), new byte[] { 1 });
      File cache = temporary.newFolder(), checkpoints = temporary.newFolder();
      translator = new NaturalCaptionTranslator(new TranslationEnvironment() {
        public File prepareCacheDirectory() { return cache; }
        public File prepareCheckpointDirectory() { return checkpoints; }
        public void verifyDeviceCapacity(File file) {}
      }, (file, folder, threads, instruction) -> {
        systemInstruction = instruction;
        return new TranslationRuntime() {
        public String translate(String prompt, int tokens) {
          lastTokens = tokens; tokenLimits.add(tokens);
          assertTrue("Every inference request must fit the conservative 3600 budget",
              TranslationText.bytes(systemInstruction) + TranslationText.bytes(prompt) + tokens + 128 <= 3600);
          return translate(prompt);
        }
        public String translate(String prompt) {
          prompts.add(prompt);
          JsonObject input = JsonParser.parseString(prompt).getAsJsonObject();
          if (!input.has("retry") && initialResponse != null) return initialResponse;
          JsonArray response = new JsonArray();
          for (var item : input.getAsJsonArray("captions")) {
            JsonObject translated = new JsonObject(); translated.add("id", item.getAsJsonObject().get("id"));
            translated.addProperty("text", rejectInitial && !input.has("retry") ? "" : output); response.add(translated);
          }
          return response.toString();
        }
        public Map<String, Object> lastGenerationDiagnostics() { return Map.of("decodeTokenCount", reportCapHit ? lastTokens : 17, "private-path", 999, "caption", "Hello"); }
        public void cancel() {} public void close() {}
      }; }, (file, cancelled, progress) -> {}, Executors.newSingleThreadExecutor(), logs::add);
    }
    public void close() { translator.close(); }
  }
}
