package app.captionstudio.translation;

import static org.junit.Assert.*;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.File;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class TranslationResponseContractTest {
  @Rule public TemporaryFolder temporary = new TemporaryFolder();

  private static final String[][] TARGETS = {
      {"en", "Please close the door."}, {"zh-Hans", "请关门。"}, {"zh-Hant", "請關門。"},
      {"hi", "कृपया दरवाजा बंद करें।"}, {"es", "Por favor, cierra la puerta."},
      {"fr", "Fermez la porte."}, {"ar", "أغلق الباب من فضلك."}, {"bn", "দরজা বন্ধ করুন।"},
      {"pt", "Feche a porta."}, {"ru", "Закройте дверь."}, {"ur", "دروازہ بند کریں۔"},
      {"id", "Tutup pintunya."}, {"de", "Bitte schließe die Tür."}, {"ja", "ドアを閉めてください。"},
      {"ko", "문을 닫아 주세요."}, {"tr", "Lütfen kapıyı kapat."}, {"vi", "Xin đóng cửa."},
      {"th", "กรุณาปิดประตู"}, {"it", "Chiudi la porta."}, {"pl", "Zamknij drzwi."},
  };

  @Test public void rejectsUnboundRetryTextForEveryTargetAndNeverCheckpointsIt() throws Exception {
    File model = temporary.newFile("model.litertlm");
    Files.write(model.toPath(), new byte[] {1});
    File cache = temporary.newFolder();
    File checkpoints = temporary.newFolder();
    for (String[] target : TARGETS) {
      int previousCheckpoints = checkpoints.list().length;
      AtomicInteger calls = new AtomicInteger();
      String source = "en".equals(target[0]) ? "请在离开之前关上房间的门，谢谢。" : "Please close the door.";
      String bleed = "c1: " + target[1] + "\nc2: " + target[1];
      // The previous length/script heuristics accept this multi-cue response.
      assertFalse(target[0], TranslationOutputQuality.needsReview(source, bleed, target[0]));
      TranslationRuntimeFactory factory = (file, folder, threads, instruction) -> new TranslationRuntime() {
        public String translate(String prompt) {
          int call = calls.incrementAndGet();
          if (call == 1) return "[]";
          if (call == 2) return bleed;
          return response("c1", target[1]);
        }
        public void cancel() {}
        public void close() {}
      };
      Map<String, Object> request = Map.of("reuseCheckpoints", true, "repairUnusableOutputs", true,
          "operations", List.of(Map.of("id", "operation", "sourceLanguage", "en".equals(target[0]) ? "zh-Hans" : "en",
              "targetLanguage", target[0], "batches", List.of(Map.of("captions", List.of(Map.of("id", "c1", "text", source)))))));
      try (NaturalCaptionTranslator translator = translator(cache, checkpoints, factory)) {
        Map<?, ?> rejected = cue(run(translator, model, request));
        assertEquals(target[0], false, rejected.get("valid"));
        assertEquals(target[0], "", rejected.get("text"));
        assertEquals(target[0], previousCheckpoints, checkpoints.list().length);
      }
      // Recreate the worker as after process death. The rejected response must be regenerated.
      try (NaturalCaptionTranslator translator = translator(cache, checkpoints, factory)) {
        assertEquals(target[0], target[1], cue(run(translator, model, request)).get("text"));
        assertEquals(target[0], 3, calls.get());
        assertEquals(target[0], previousCheckpoints + 1, checkpoints.list().length);
      }
      try (NaturalCaptionTranslator translator = translator(cache, checkpoints, factory)) {
        assertEquals(target[0], target[1], cue(run(translator, model, request)).get("text"));
        assertEquals(target[0], 3, calls.get());
      }
    }
  }

  @Test public void batchAndRetryRejectTheSameMalformedSchemaAndControlText() throws Exception {
    var expected = new NaturalCaptionTranslator.Caption("c2", "Close the door");
    for (String response : new String[] {
        "Cierra la puerta.", "c2: Cierra la puerta.", "\"Cierra la puerta.\"",
        "[]", response("c1", "Cierra la puerta"),
        "[{\"id\":\"c2\",\"id\":\"c2\",\"text\":\"Cierra\"}]",
        "[{\"id\":\"c2\",\"text\":\"Cierra\",\"extra\":true}]",
        "[{\"id\":\"c2\",\"text\":null}]", "[{\"id\":2,\"text\":\"Cierra\"}]",
        response("c2", "Cierra") + " trailing", "```json\n" + response("c2", "Cierra") + "\n```",
        response("c2", "<|assistant|>Cierra"), response("c2", "Cierra\u0000la puerta"),
    }) {
      assertFalse(response, NaturalCaptionTranslator.parseStrictResponse(response, List.of(expected)).get(0).valid);
      assertFalse(response, NaturalCaptionTranslator.parseSingleCaptionRetryResponse(response, expected).valid);
    }
  }

  @Test public void rejectsReorderedIdsInsteadOfSilentlyRepairingTheContract() throws Exception {
    var expected = List.of(new NaturalCaptionTranslator.Caption("c1", "Hello"),
        new NaturalCaptionTranslator.Caption("c2", "Goodbye"));
    var actual = NaturalCaptionTranslator.parseStrictResponse(
        "[{\"id\":\"c2\",\"text\":\"你好\"},{\"id\":\"c1\",\"text\":\"再见\"}]", expected);
    for (var cue : actual) { assertFalse(cue.valid); assertEquals("", cue.text); }
  }

  @Test public void legacyNormalizedRetryCheckpointCannotBypassTheNewContract() throws Exception {
    File model = temporary.newFile("legacy-model.litertlm");
    Files.write(model.toPath(), new byte[] {1});
    File cache = temporary.newFolder();
    File checkpoints = temporary.newFolder();
    var request = Map.<String, Object>of("reuseCheckpoints", true, "repairUnusableOutputs", true,
        "operations", List.of(Map.of("id", "operation", "sourceLanguage", "en", "targetLanguage", "es",
            "batches", List.of(Map.of("captions", List.of(Map.of("id", "c1", "text", "Close the door")))))));
    var batch = NaturalCaptionTranslator.validateSessionRequest(request).batches.get(0);
    var systemField = NaturalCaptionTranslator.class.getDeclaredField("SYSTEM_INSTRUCTION");
    systemField.setAccessible(true);
    String oldSystem = ((String) systemField.get(null)).replace(
        "The item count, item order, and every id must exactly match the input, including on single-cue retries. Never use Markdown or code fences. ",
        "The item count, item order, and every id must exactly match the input. For translate_single_caption requests whose responseFormat is single_caption_text, return only the translated cue text with no id, label, wrapper, or explanation. Never use Markdown or code fences. ");
    String oldProfile = "v3;litertlm-0.16.1;cpu;4096;1536;topk1;topp1;temperature0;seed0;single-cue-text-repair;strict-boundary";
    String key = TranslationCheckpointStore.key(OfficialQwenModelVerifier.EXPECTED_MODEL_SHA256 + "\n" + oldProfile
        + "\n" + NaturalCaptionTranslator.PROMPT_CONTRACT + "\n" + oldSystem + "\ntrue\n" + NaturalCaptionTranslator.buildUserPrompt(batch));
    // v3 rewrapped unbound plain text as valid JSON. Parsing that file again cannot recover its provenance.
    String legacy = response("c1", "c1: Cierra la puerta.\nc2: Abre la ventana.");
    TranslationCheckpointStore store = new TranslationCheckpointStore(checkpoints);
    store.write(key, legacy);
    AtomicInteger generated = new AtomicInteger();
    TranslationRuntimeFactory factory = (file, folder, threads, instruction) -> new TranslationRuntime() {
      public String translate(String prompt) { generated.incrementAndGet(); return response("c1", "Cierra la puerta."); }
      public void cancel() {}
      public void close() {}
    };
    try (NaturalCaptionTranslator translator = translator(cache, checkpoints, factory)) {
      assertEquals("Cierra la puerta.", cue(run(translator, model, request)).get("text"));
      assertEquals(1, generated.get());
    }
    assertEquals(legacy, store.read(key));
  }

  @Test public void retryUsesBatchSchemaWithOnlyTheRequestedIdAndBoundedContext() throws Exception {
    var request = new NaturalCaptionTranslator.ValidatedRequest("en", "es",
        List.of(new NaturalCaptionTranslator.Caption("c1", "First cue"),
            new NaturalCaptionTranslator.Caption("c2", "Close the door"),
            new NaturalCaptionTranslator.Caption("c3", "Last cue")), "Before", "After");
    var prompt = JsonParser.parseString(NaturalCaptionTranslator.buildRetryPrompt(request, 1)).getAsJsonObject();
    assertEquals("translate_caption_batch", prompt.get("task").getAsString());
    assertFalse(prompt.has("responseFormat"));
    assertTrue(prompt.get("retry").getAsBoolean());
    assertEquals(1, prompt.getAsJsonArray("captions").size());
    assertEquals("c2", prompt.getAsJsonArray("captions").get(0).getAsJsonObject().get("id").getAsString());
    assertTrue(prompt.get("contextBefore").getAsString().contains("First cue"));
    assertTrue(prompt.get("contextAfter").getAsString().contains("Last cue"));
    assertFalse(NaturalCaptionTranslator.parseSingleCaptionRetryResponse(response("c1", "Cierra la puerta"), request.captions.get(1)).valid);
    assertTrue(NaturalCaptionTranslator.parseSingleCaptionRetryResponse(response("c2", "Cierra\nla puerta"), request.captions.get(1)).valid);
  }

  private static String response(String id, String text) {
    JsonObject item = new JsonObject(); item.addProperty("id", id); item.addProperty("text", text);
    JsonArray array = new JsonArray(); array.add(item); return array.toString();
  }

  private NaturalCaptionTranslator translator(File cache, File checkpoints, TranslationRuntimeFactory factory) {
    return new NaturalCaptionTranslator(new TranslationEnvironment() {
      public File prepareCacheDirectory() { return cache; }
      public File prepareCheckpointDirectory() { return checkpoints; }
      public void verifyDeviceCapacity(File model) {}
    }, factory, (model, cancelled, progress) -> {}, Executors.newSingleThreadExecutor());
  }

  private static Map<String, Object> run(NaturalCaptionTranslator translator, File model, Map<String, Object> request) throws Exception {
    CountDownLatch done = new CountDownLatch(1);
    AtomicReference<Map<String, Object>> result = new AtomicReference<>();
    AtomicReference<String> failure = new AtomicReference<>();
    translator.start(model.getAbsolutePath(), request, new NaturalCaptionTranslator.Callback() {
      public void onSuccess(Map<String, Object> value) { result.set(value); done.countDown(); }
      public void onError(String code, String message, Throwable cause) { failure.set(code + ": " + message); done.countDown(); }
    });
    assertTrue("Translation timed out", done.await(10, TimeUnit.SECONDS));
    assertNull(failure.get());
    return result.get();
  }

  private static Map<?, ?> cue(Map<String, Object> result) {
    return (Map<?, ?>) ((List<?>) result.get("captions")).get(0);
  }
}
