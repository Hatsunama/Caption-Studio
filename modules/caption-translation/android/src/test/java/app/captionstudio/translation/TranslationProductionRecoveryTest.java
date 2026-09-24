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
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class TranslationProductionRecoveryTest {
  @Rule public TemporaryFolder temporary = new TemporaryFolder();

  @Test public void malformedEightCueBatchHasOnlyOneRecoveryPerCueThroughProductionWrapper() throws Exception {
    for (boolean fallback : new boolean[] {false, true}) {
      List<Boolean> flags = new ArrayList<>();
      Map<String, Object> result = run(flags, fallback, false);
      assertEquals(9, flags.size());
      assertEquals(Boolean.TRUE, flags.get(0));
      for (int i = 1; i < flags.size(); i++) assertTrue(flags.get(i));
      for (Object item : (List<?>) result.get("captions")) {
        Map<?, ?> cue = (Map<?, ?>) item;
        assertEquals(false, cue.get("valid"));
        assertEquals("", cue.get("text"));
        assertEquals("MALFORMED_JSON", cue.get("failureReason"));
      }
      assertEquals(fallback, result.get("initializationFallback"));
    }
  }

  @Test public void mixedFailuresPreserveAcceptedCuesAndSourceNeighbors() throws Exception {
    List<Boolean> flags = new ArrayList<>();
    Map<String, Object> result = run(flags, false, true);
    assertEquals(List.of(true, true, true), flags);
    for (Object item : (List<?>) result.get("captions")) {
      Map<?, ?> cue = (Map<?, ?>) item;
      assertEquals(true, cue.get("valid"));
      assertEquals("Bonjour", cue.get("text"));
    }
  }

  @Test public void unsupportedRuntimeCannotSilentlyDropRequiredStructuredOutput() {
    TranslationRuntime legacy = new TranslationRuntime() {
      public String translate(String prompt) { throw new AssertionError("Must not generate"); }
      public void cancel() {}
      public void close() {}
    };
    assertThrows(UnsupportedOperationException.class, () -> legacy.translate("private", 128, true));
  }

  private Map<String, Object> run(List<Boolean> flags, boolean fallback, boolean mixed) throws Exception {
    File model = temporary.newFile("model-" + System.nanoTime() + ".litertlm");
    Files.write(model.toPath(), new byte[] {1});
    TranslationRuntimeFactory factory = (m, c, t, s) -> TranslationBackendSelection.open(
        fallback ? TranslationBackendSelection.Preference.AUTO : TranslationBackendSelection.Preference.CPU,
        backend -> new TranslationBackendSelection.Candidate() {
          public TranslationRuntime initialize() {
            if (fallback && backend.equals("gpu")) throw new IllegalStateException("private driver");
            return new TranslationRuntime() {
              public boolean supportsStructuredOutput() { return true; }
              public String translate(String prompt) { throw new AssertionError("Lost request settings"); }
              public String translate(String prompt, int tokens, boolean structured) {
                flags.add(structured);
                assertTrue(tokens >= 128 && tokens <= 1024);
                JsonObject input = JsonParser.parseString(prompt).getAsJsonObject();
                JsonArray requested = input.getAsJsonArray("captions");
                if (flags.size() > 1) {
                  assertTrue(structured);
                  assertTrue(input.get("retry").getAsBoolean());
                  assertEquals(1, requested.size());
                  int index = Integer.parseInt(requested.get(0).getAsJsonObject().get("id").getAsString().substring(1));
                  if (mixed) assertTrue(index == 2 || index == 5);
                  JsonObject neighbors = input.getAsJsonObject("sourceNeighbors");
                  assertTrue(neighbors.get("before").getAsString().endsWith(index == 0 ? "Before" : "Hello " + (index - 1)));
                  assertTrue(neighbors.get("after").getAsString().startsWith(index == 7 ? "After" : "Hello " + (index + 1)));
                  assertFalse(prompt.contains("Bonjour"));
                }
                if (!mixed) return "[";
                JsonArray output = new JsonArray();
                for (var element : requested) {
                  String id = element.getAsJsonObject().get("id").getAsString();
                  JsonObject item = new JsonObject();
                  item.addProperty("id", id);
                  item.addProperty("text", flags.size() == 1 && id.equals("c2") ? ""
                      : flags.size() == 1 && id.equals("c5") ? "Hello 5" : "Bonjour");
                  output.add(item);
                }
                return output.toString();
              }
              public void cancel() {}
              public void close() {}
            };
          }
          public void close() {}
        }, () -> false);
    try (NaturalCaptionTranslator translator = new NaturalCaptionTranslator(new TranslationEnvironment() {
      public File prepareCacheDirectory() { return temporary.getRoot(); }
      public void verifyDeviceCapacity(File file) {}
    }, factory, (file, cancelled, progress) -> {}, Executors.newSingleThreadExecutor(), line -> {})) {
      List<Map<String, String>> captions = new ArrayList<>();
      for (int i = 0; i < 8; i++) captions.add(Map.of("id", "c" + i, "text", "Hello " + i));
      CountDownLatch done = new CountDownLatch(1);
      AtomicReference<Map<String, Object>> result = new AtomicReference<>();
      AtomicReference<String> error = new AtomicReference<>();
      translator.start(model.getAbsolutePath(), Map.of("repairUnusableOutputs", true,
          "operations", List.of(Map.of("id", "op", "sourceLanguage", "en", "targetLanguage", "fr",
              "batches", List.of(Map.of("captions", captions, "contextBefore", "Before", "contextAfter", "After"))))),
          new NaturalCaptionTranslator.Callback() {
            public void onSuccess(Map<String, Object> value) { result.set(value); done.countDown(); }
            public void onError(String code, String message, Throwable cause) { error.set(code); done.countDown(); }
          });
      assertTrue(done.await(10, TimeUnit.SECONDS));
      assertNull(error.get());
      return result.get();
    }
  }
}
