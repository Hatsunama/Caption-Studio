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
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class TranslationBatchMetricsTest {
  @Rule public TemporaryFolder temporary = new TemporaryFolder();
  private static final Set<String> METRIC_KEYS = Set.of("batchIndex", "captionCount", "backend",
      "initializationFallback", "durationMs", "initializationMs", "generationMs", "attempts",
      "repairAttempts", "generationFailures", "invalidOutputs", "qualityRejections", "outcome");

  @Test public void metricsContainOnlyApprovedCountersAndSafeEnums() throws Exception {
    TranslationBatchMetrics metrics = new TranslationBatchMetrics(2, 8);
    metrics.initializationNanos = 3_000_000;
    TranslationRuntime runtime = runtime("secret backend", () -> "secret response", new AtomicInteger());
    assertEquals("secret response", metrics.generate(runtime, "secret prompt", 128, false));
    metrics.generate(runtime, "secret repair", 128, true);
    metrics.reject(false);
    metrics.reject(true);
    Map<String, Object> values = metrics.finish(true, false);
    assertEquals(METRIC_KEYS, values.keySet());
    assertFalse(values.toString().contains("secret"));
    assertEquals("unknown", values.get("backend"));
    assertEquals(2, values.get("attempts"));
    assertEquals(1, values.get("repairAttempts"));
    assertEquals(1, values.get("invalidOutputs"));
    assertEquals(1, values.get("qualityRejections"));
    assertEquals(3L, values.get("initializationMs"));
    assertTrue((long) values.get("generationMs") >= 0);
    assertTrue((long) values.get("durationMs") >= 0);
  }

  @Test public void failedAndCancelledGenerationRemainObservableWithoutExceptionText() {
    for (RuntimeException failure : List.of(new IllegalStateException("secret"), new CancellationException("secret"))) {
      TranslationBatchMetrics metrics = new TranslationBatchMetrics(0, 1);
      assertThrows(failure.getClass(), () -> metrics.generate(
          runtime("gpu", () -> { throw failure; }, new AtomicInteger()), "secret", 128, false));
      Map<String, Object> values = metrics.finish(false, false);
      assertEquals(1, values.get("generationFailures"));
      assertEquals(failure instanceof CancellationException ? "cancelled" : "failed", values.get("outcome"));
      assertEquals("gpu", values.get("backend"));
      assertFalse(values.toString().contains("secret"));
    }
  }

  @Test public void actualBackendAndMetricsReachResultWithoutChangingCaptionContract() throws Exception {
    for (String backend : List.of("cpu", "gpu")) {
      AtomicInteger closed = new AtomicInteger();
      try (NaturalCaptionTranslator translator = translator((file, cache, threads, instruction) ->
          runtime(backend, () -> "[{\"id\":\"cue\",\"text\":\"Bonjour\"}]", closed))) {
        Result result = run(translator, request("en", "fr"));
        assertNull(result.error);
        assertEquals(backend, result.value.get("backend"));
        assertEquals(List.of(Map.of("id", "cue", "text", "Bonjour", "valid", true)), result.value.get("captions"));
        assertEquals(true, result.value.get("offline"));
        assertEquals(GeneratedProductContract.MODEL_ID, result.value.get("modelId"));
        assertEquals(GeneratedProductContract.PROMPT_CONTRACT, result.value.get("promptContract"));
        Map<?, ?> metrics = (Map<?, ?>) ((List<?>) result.value.get("batchMetrics")).get(0);
        assertEquals(METRIC_KEYS, metrics.keySet());
        assertEquals(backend, metrics.get("backend"));
        assertEquals(1, metrics.get("attempts"));
        assertEquals("completed", metrics.get("outcome"));
        assertEquals(1, closed.get());
      }
    }
  }

  @Test public void identityReportsNoBackendOrGeneration() throws Exception {
    try (NaturalCaptionTranslator translator = translator((file, cache, threads, instruction) -> {
      throw new AssertionError("No engine needed");
    })) {
      Result result = run(translator, request("en", "en"));
      assertNull(result.error);
      assertEquals("none", result.value.get("backend"));
      Map<?, ?> metrics = (Map<?, ?>) ((List<?>) result.value.get("batchMetrics")).get(0);
      assertEquals("none", metrics.get("backend"));
      assertEquals(0, metrics.get("attempts"));
    }
  }

  @Test public void nativeRequestPassesCpuOverrideAndRejectsInvalidPreference() throws Exception {
    AtomicInteger opens = new AtomicInteger();
    TranslationRuntimeFactory factory = new TranslationRuntimeFactory() {
      public TranslationRuntime open(File m, File c, int t, String s) { throw new AssertionError(); }
      public TranslationRuntime open(File m, File c, int t, String s,
          TranslationBackendSelection.Preference preference, java.util.function.BooleanSupplier cancelled) {
        assertEquals(TranslationBackendSelection.Preference.CPU, preference);
        opens.incrementAndGet();
        return runtime("cpu", () -> "[]", new AtomicInteger());
      }
    };
    try (NaturalCaptionTranslator translator = translator(factory)) {
      Map<String, Object> request = new java.util.LinkedHashMap<>(request("en", "fr"));
      request.put("runtimeBackend", "cpu");
      assertNull(run(translator, request).error);
      request.put("runtimeBackend", "npu");
      assertEquals(NaturalCaptionTranslator.INVALID_REQUEST, run(translator, request).error);
      assertEquals(1, opens.get());
    }
  }

  @Test public void rejectedOutputRepairIsCountedWithoutAlteringAcceptedText() throws Exception {
    AtomicInteger calls = new AtomicInteger();
    try (NaturalCaptionTranslator translator = translator((file, cache, threads, instruction) ->
        runtime("gpu", () -> calls.incrementAndGet() == 1 ? "[]" :
            "[{\"id\":\"cue\",\"text\":\"Bonjour\"}]", new AtomicInteger()))) {
      Map<String, Object> request = new java.util.LinkedHashMap<>(request("en", "fr"));
      request.put("repairUnusableOutputs", true);
      Result result = run(translator, request);
      assertNull(result.error);
      Map<?, ?> metrics = (Map<?, ?>) ((List<?>) result.value.get("batchMetrics")).get(0);
      assertEquals(2, metrics.get("attempts"));
      assertEquals(1, metrics.get("repairAttempts"));
      assertEquals(1, metrics.get("invalidOutputs"));
      assertEquals(List.of(Map.of("id", "cue", "text", "Bonjour", "valid", true)), result.value.get("captions"));
    }
  }

  @Test public void rejectedStructuredCueUsesConstrainedRepair() throws Exception {
    List<Boolean> structured = new ArrayList<>();
    AtomicInteger calls = new AtomicInteger();
    try (NaturalCaptionTranslator translator = translator((file, cache, threads, instruction) ->
        new TranslationRuntime() {
          public boolean supportsStructuredOutput() { return true; }
          public String translate(String prompt) { throw new AssertionError("Expected per-request settings"); }
          public String translate(String prompt, int tokens, boolean requireStructuredOutput) {
            structured.add(requireStructuredOutput);
            return calls.incrementAndGet() == 1 ? "[]" : "[{\"id\":\"cue\",\"text\":\"Bonjour\"}]";
          }
          public void cancel() {}
          public void close() {}
        })) {
      Map<String, Object> request = new java.util.LinkedHashMap<>(request("en", "fr"));
      request.put("repairUnusableOutputs", true);
      Result result = run(translator, request);
      assertNull(result.error);
      assertEquals(List.of(true, true), structured);
      assertEquals(List.of(Map.of("id", "cue", "text", "Bonjour", "valid", true)),
          result.value.get("captions"));
    }
  }

  @Test public void groupedGenerationUsesStructuredOutputWithoutFifteenSingletonRepairs() throws Exception {
    List<Boolean> structured = new ArrayList<>();
    List<Map<String, String>> captions = new ArrayList<>();
    for (int index = 0; index < 15; index++) {
      captions.add(Map.of("id", "c" + index, "text", "Hello " + index));
    }
    TranslationRuntimeFactory factory = (file, cache, threads, instruction) -> new TranslationRuntime() {
      public boolean supportsStructuredOutput() { return true; }
      public String translate(String prompt) { throw new AssertionError("Expected per-request settings"); }
      public String translate(String prompt, int tokens, boolean requireStructuredOutput) {
        structured.add(requireStructuredOutput);
        JsonObject input = JsonParser.parseString(prompt).getAsJsonObject();
        assertEquals("Earlier source", input.get("contextBefore").getAsString());
        assertEquals("Later source", input.get("contextAfter").getAsString());
        if (!requireStructuredOutput) return "[]";
        JsonArray output = new JsonArray();
        for (var element : input.getAsJsonArray("captions")) {
          JsonObject item = new JsonObject();
          item.addProperty("id", element.getAsJsonObject().get("id").getAsString());
          item.addProperty("text", "Bonjour");
          output.add(item);
        }
        return output.toString();
      }
      public void cancel() {}
      public void close() {}
    };
    try (NaturalCaptionTranslator translator = translator(factory)) {
      Map<String, Object> request = Map.of("repairUnusableOutputs", true,
          "operations", List.of(Map.of("id", "op", "sourceLanguage", "en", "targetLanguage", "fr",
              "batches", List.of(Map.of("captions", captions,
                  "contextBefore", "Earlier source", "contextAfter", "Later source")))));
      Result result = run(translator, request);
      assertNull(result.error);
      assertEquals(15, ((List<?>) result.value.get("captions")).size());
      for (Object cue : (List<?>) result.value.get("captions")) {
        assertEquals(true, ((Map<?, ?>) cue).get("valid"));
      }
      assertEquals(List.of(true, true), structured);
      Map<?, ?> metrics = (Map<?, ?>) ((List<?>) result.value.get("batchMetrics")).get(0);
      assertEquals(2, metrics.get("attempts"));
      assertEquals(0, metrics.get("repairAttempts"));
    }
  }

  @Test public void generationFailureClosesRuntimeAndNeverReopens() throws Exception {
    AtomicInteger opens = new AtomicInteger();
    AtomicInteger closes = new AtomicInteger();
    try (NaturalCaptionTranslator translator = translator((file, cache, threads, instruction) -> {
      opens.incrementAndGet();
      return runtime("gpu", () -> { throw new IllegalStateException("secret caption"); }, closes);
    })) {
      Result result = run(translator, request("en", "fr"));
      assertEquals(NaturalCaptionTranslator.FAILED, result.error);
      assertNull(result.value);
      assertEquals(1, opens.get());
      assertEquals(1, closes.get());
    }
  }

  @Test public void benchmarkBypassesCpuCheckpointsWithoutOverwritingNormalResume() throws Exception {
    File checkpoints = temporary.newFolder();
    Map<String, Object> normal = new java.util.LinkedHashMap<>(request("en", "fr"));
    normal.put("reuseCheckpoints", true);
    try (NaturalCaptionTranslator cpu = translator((m, c, t, s) ->
        runtime("cpu", () -> "[{\"id\":\"cue\",\"text\":\"Bonjour\"}]", new AtomicInteger()), checkpoints)) {
      Result baseline = run(cpu, normal);
      assertNull(baseline.error);
      assertEquals("cpu", baseline.value.get("backend"));
      assertEquals(false, baseline.value.get("benchmarkNoCheckpoints"));
    }
    AtomicInteger opens = new AtomicInteger();
    try (NaturalCaptionTranslator gpu = translator((m, c, t, s) -> {
      opens.incrementAndGet();
      return runtime("gpu", () -> "[{\"id\":\"cue\",\"text\":\"Salut\"}]", new AtomicInteger());
    }, checkpoints)) {
      Map<String, Object> diagnostic = new java.util.LinkedHashMap<>(normal);
      diagnostic.put("runtimeBackend", "gpu");
      diagnostic.put("benchmarkNoCheckpoints", true);
      Result measured = run(gpu, diagnostic);
      assertNull(measured.error);
      assertEquals("gpu", measured.value.get("backend"));
      assertEquals(true, measured.value.get("benchmarkNoCheckpoints"));
      assertEquals(List.of(Map.of("id", "cue", "text", "Salut", "valid", true)), measured.value.get("captions"));
      Map<?, ?> metrics = (Map<?, ?>) ((List<?>) measured.value.get("batchMetrics")).get(0);
      assertEquals(1, metrics.get("attempts"));
      assertEquals("gpu", metrics.get("backend"));

      // Benchmark output must not replace the accepted CPU text, and resume must still work.
      Result restored = run(gpu, normal);
      assertNull(restored.error);
      assertEquals(List.of(Map.of("id", "cue", "text", "Bonjour", "valid", true)), restored.value.get("captions"));
      assertEquals("none", restored.value.get("backend"));
      assertEquals(1, opens.get());
    }
  }

  @Test public void benchmarkNeverPreparesCheckpointStorageAndRejectsNonBooleanFlag() throws Exception {
    try (NaturalCaptionTranslator translator = new NaturalCaptionTranslator(new TranslationEnvironment() {
      public File prepareCacheDirectory() { return temporary.getRoot(); }
      public File prepareCheckpointDirectory() { throw new AssertionError("Benchmark touched checkpoint storage"); }
      public void verifyDeviceCapacity(File model) {}
    }, (m, c, t, s) -> runtime("cpu", () -> "[]", new AtomicInteger()),
        (file, cancelled, progress) -> {}, Executors.newSingleThreadExecutor())) {
      Map<String, Object> request = new java.util.LinkedHashMap<>(request("en", "fr"));
      request.put("reuseCheckpoints", true);
      request.put("benchmarkNoCheckpoints", true);
      assertNull(run(translator, request).error);
      request.put("benchmarkNoCheckpoints", "true");
      assertEquals(NaturalCaptionTranslator.INVALID_REQUEST, run(translator, request).error);
    }
  }

  @Test public void initializationFallbackReportsCpuInBothResultAndBatchMetrics() throws Exception {
    AtomicInteger closes = new AtomicInteger();
    try (NaturalCaptionTranslator translator = translator((m, c, t, s) ->
        TranslationBackendSelection.open(TranslationBackendSelection.Preference.GPU, backend ->
            new TranslationBackendSelection.Candidate() {
              public TranslationRuntime initialize() {
                if (backend.equals("gpu")) throw new IllegalStateException("private driver error");
                return runtime("cpu", () -> "[{\"id\":\"cue\",\"text\":\"Bonjour\"}]", closes);
              }
              public void close() { closes.incrementAndGet(); }
            }, () -> false))) {
      Result result = run(translator, request("en", "fr"));
      assertNull(result.error);
      assertEquals("cpu", result.value.get("backend"));
      assertEquals(true, result.value.get("initializationFallback"));
      Map<?, ?> metrics = (Map<?, ?>) ((List<?>) result.value.get("batchMetrics")).get(0);
      assertEquals("cpu", metrics.get("backend"));
      assertEquals(true, metrics.get("initializationFallback"));
      assertEquals(2, closes.get());
    }
  }

  private interface Generate { String run(); }
  private static TranslationRuntime runtime(String backend, Generate generate, AtomicInteger closes) {
    return new TranslationRuntime() {
      public String backendName() { return backend; }
      public String translate(String prompt) { return generate.run(); }
      public void cancel() {}
      public void close() { closes.incrementAndGet(); }
    };
  }

  private NaturalCaptionTranslator translator(TranslationRuntimeFactory factory) {
    return translator(factory, null);
  }

  private NaturalCaptionTranslator translator(TranslationRuntimeFactory factory, File checkpoints) {
    return new NaturalCaptionTranslator(new TranslationEnvironment() {
      public File prepareCacheDirectory() { return temporary.getRoot(); }
      public File prepareCheckpointDirectory() { return checkpoints; }
      public void verifyDeviceCapacity(File file) {}
    }, factory, (file, cancelled, progress) -> {}, Executors.newSingleThreadExecutor());
  }

  private static Map<String, Object> request(String source, String target) {
    return Map.of("operations", List.of(Map.of("id", "op", "sourceLanguage", source,
        "targetLanguage", target, "batches", List.of(Map.of("captions",
            List.of(Map.of("id", "cue", "text", "Hello")))))));
  }

  private Result run(NaturalCaptionTranslator translator, Map<String, Object> request) throws Exception {
    File model = temporary.newFile("model-" + System.nanoTime() + ".litertlm");
    Files.write(model.toPath(), new byte[] {1});
    Result result = new Result();
    translator.start(model.getAbsolutePath(), request, result);
    assertTrue(result.done.await(10, TimeUnit.SECONDS));
    return result;
  }

  private static final class Result implements NaturalCaptionTranslator.Callback {
    final CountDownLatch done = new CountDownLatch(1);
    Map<String, Object> value;
    String error;
    public void onSuccess(Map<String, Object> value) { this.value = value; done.countDown(); }
    public void onError(String code, String message, Throwable cause) { error = code; done.countDown(); }
  }
}
