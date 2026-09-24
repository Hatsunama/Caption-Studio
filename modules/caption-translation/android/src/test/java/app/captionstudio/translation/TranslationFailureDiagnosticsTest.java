package app.captionstudio.translation;

import static org.junit.Assert.*;

import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class TranslationFailureDiagnosticsTest {
  @Rule public TemporaryFolder temporary = new TemporaryFolder();
  private static final String SOURCE = "content creators, and I'm really";
  private static final String ID = "private-caption-id";

  @Test public void classifiesStructuralAndTextFailuresWithoutLeakingPayloads() throws Exception {
    String[][] cases = {
        {null, "NULL_RESPONSE"}, {"", "EMPTY_RESPONSE"}, {"x".repeat(65537), "RESPONSE_TOO_LONG"},
        {"{}", "ROOT_NOT_ARRAY"}, {"[1]", "ITEM_NOT_OBJECT"},
        {"[{\"id\":1}]", "FIELD_NOT_STRING"},
        {"[{\"id\":\"x\",\"id\":\"y\"}]", "DUPLICATE_FIELD"},
        {"[{\"secret\":\"private-data\"}]", "UNKNOWN_FIELD"},
        {"[{}]", "MISSING_FIELD"}, {response("wrong-id", "hello"), "UNKNOWN_ID"},
        {"[]", "ITEM_COUNT"}, {"[", "MALFORMED_JSON"},
        {response(ID, ""), "BLANK_TEXT"}, {response(ID, "x".repeat(2001)), "TEXT_TOO_LONG"},
        {response(ID, "<|private|>"), "CHAT_DELIMITER"},
        {"[{\"id\":\"" + ID + "\",\"text\":\"bad\\u0000text\"}]", "CONTROL_CHARACTER"},
        {"[{\"id\":\"" + ID + "\",\"text\":\"\\ud800\"}]", "INVALID_UNICODE"},
        {response(ID, "x".repeat(200)), "IMPLAUSIBLE_LENGTH"},
        {response(ID, "bonjour"), "QUALITY_REVIEW"},
        {response(ID, "\u4f60\u597d") + " []", "TRAILING_CONTENT"}
    };
    for (String[] entry : cases) {
      List<String> logs = new ArrayList<>();
      Map<String, Object> result = run(List.of(Map.of("id", ID, "text", SOURCE)), false,
          prompt -> entry[0], logs::add, false);
      assertEquals(entry[1], 1, logs.size());
      assertTrue(entry[1] + ": " + logs, logs.get(0).contains("failure=" + entry[1] + " "));
      assertEquals(false, cue(result, 0).get("valid"));
      assertEquals("", cue(result, 0).get("text"));
      assertEquals(entry[1], cue(result, 0).get("failureReason"));
      assertSafe(logs);
    }
  }

  @Test public void preservesInitialSingletonAndRepairFailuresInOrder() throws Exception {
    AtomicInteger calls = new AtomicInteger();
    List<String> logs = new ArrayList<>();
    Map<String, Object> result = run(List.of(Map.of("id", ID, "text", SOURCE),
        Map.of("id", "second-private-id", "text", "Hello")), true, prompt -> {
          switch (calls.incrementAndGet()) {
            case 1: return "[]";
            case 2: return response(ID, "bonjour");
            default: return response("second-private-id", "\u4f60\u597d");
          }
        }, logs::add, false);
    assertEquals(3, calls.get());
    assertEquals(2, logs.size());
    assertTrue(logs.get(0).contains("attempt=1 stage=INITIAL phase=PARSE failure=ITEM_COUNT"));
    assertTrue(logs.get(0).contains("expected=2 actual=0"));
    assertTrue(logs.get(1).contains("attempt=2 stage=REPAIR phase=QUALITY failure=QUALITY_REVIEW"));
    assertEquals("QUALITY_REVIEW", cue(result, 0).get("failureReason"));
    assertEquals(true, cue(result, 1).get("valid"));
    assertSafe(logs);
  }

  @Test public void generationFailureIsLoggedWithoutExceptionDetails() throws Exception {
    List<String> logs = new ArrayList<>();
    run(List.of(Map.of("id", ID, "text", SOURCE)), true,
        prompt -> { throw new IllegalStateException("private-model-output C:/private/path"); }, logs::add, true);
    assertEquals(1, logs.size());
    assertTrue(logs.get(0).contains("phase=GENERATION failure=GENERATION_EXCEPTION"));
    assertTrue(logs.get(0).contains("actual=-1"));
    assertSafe(logs);
  }

  @Test public void brokenDiagnosticSinkCannotChangeTranslationOutcome() throws Exception {
    AtomicInteger calls = new AtomicInteger();
    Map<String, Object> result = run(List.of(Map.of("id", ID, "text", SOURCE)), true,
        prompt -> calls.incrementAndGet() == 1 ? "[]" : response(ID, "\u5185\u5bb9\u521b\u4f5c\u8005\uff0c\u800c\u4e14\u6211\u771f\u7684"),
        line -> { throw new IllegalStateException("logger unavailable"); }, false);
    assertEquals(2, calls.get());
    assertEquals(true, cue(result, 0).get("valid"));
  }

  private Map<String, Object> run(List<Map<String, String>> captions, boolean repair,
      Generator generator, Consumer<String> sink, boolean expectError) throws Exception {
    File model = temporary.newFile();
    File namedModel = new File(model.getParentFile(), model.getName() + ".litertlm");
    Files.write(namedModel.toPath(), new byte[] {1});
    File cache = temporary.newFolder();
    TranslationEnvironment environment = new TranslationEnvironment() {
      public File prepareCacheDirectory() { return cache; }
      public void verifyDeviceCapacity(File file) {}
    };
    TranslationRuntimeFactory factory = (file, folder, threads, instruction) -> new TranslationRuntime() {
      public String translate(String prompt) throws Exception { return generator.generate(prompt); }
      public void cancel() {}
      public void close() {}
    };
    // Reflection lets these regressions compile and fail against the pre-diagnostic implementation.
    var constructor = NaturalCaptionTranslator.class.getDeclaredConstructor(TranslationEnvironment.class,
        TranslationRuntimeFactory.class, TranslationModelVerifier.class, ExecutorService.class, Consumer.class);
    constructor.setAccessible(true);
    ExecutorService worker = Executors.newSingleThreadExecutor();
    try (NaturalCaptionTranslator translator = constructor.newInstance(environment, factory,
        (TranslationModelVerifier) (file, cancelled, progress) -> {}, worker, sink)) {
      CountDownLatch done = new CountDownLatch(1);
      AtomicReference<Map<String, Object>> result = new AtomicReference<>();
      AtomicReference<String> error = new AtomicReference<>();
      translator.start(namedModel.getAbsolutePath(), Map.of("repairUnusableOutputs", repair,
          "operations", List.of(Map.of("id", "private-operation", "sourceLanguage", "en",
              "targetLanguage", "zh-Hans", "batches", List.of(Map.of("captions", captions))))),
          new NaturalCaptionTranslator.Callback() {
            public void onSuccess(Map<String, Object> value) { result.set(value); done.countDown(); }
            public void onError(String code, String message, Throwable cause) { error.set(code); done.countDown(); }
          });
      assertTrue(done.await(10, TimeUnit.SECONDS));
      assertEquals(expectError, error.get() != null);
      return result.get();
    } finally { worker.shutdownNow(); }
  }

  private static void assertSafe(List<String> logs) {
    for (String log : logs) assertTrue(log, log.matches(
        "batch=[0-9]+ attempt=[0-9]+ stage=[A-Z_]+ phase=[A-Z_]+ failure=[A-Z_]+ group=[0-9]+ item=-?[0-9]+ promptBucket=-?[0-9]+ outputBucket=-?[0-9]+ textBucket=-?[0-9]+ tokens=[0-9]+ expected=[0-9]+ actual=-?[0-9]+"));
  }

  private static String response(String id, String text) {
    com.google.gson.JsonObject item = new com.google.gson.JsonObject();
    item.addProperty("id", id); item.addProperty("text", text);
    return "[" + item + "]";
  }

  private static Map<?, ?> cue(Map<String, Object> result, int index) {
    return (Map<?, ?>) ((List<?>) result.get("captions")).get(index);
  }

  private interface Generator { String generate(String prompt) throws Exception; }
}
