package app.captionstudio.translation;

import static org.junit.Assert.*;
import com.google.gson.JsonParser;
import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
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

public final class TranslationRepairTest {
  @Rule public TemporaryFolder directory = new TemporaryFolder();

  @Test public void retriesOneCueWithContextInOneEngineAndRestoresWithoutReloading() throws Exception {
    File model = directory.newFile("model.litertlm");
    Files.write(model.toPath(), new byte[] { 1 });
    File cache = directory.newFolder("cache");
    File checkpoints = directory.newFolder("checkpoints");
    AtomicInteger opened = new AtomicInteger();
    AtomicInteger closed = new AtomicInteger();
    List<String> prompts = new ArrayList<>();
    TranslationRuntimeFactory factory = (file, folder, threads, instruction) -> {
      opened.incrementAndGet();
      assertTrue(instruction.contains("colloquialisms"));
      return new TranslationRuntime() {
        public String translate(String prompt) {
          prompts.add(prompt);
          return prompts.size() == 1
              ? "[{\"id\":\"c1\",\"text\":\"\u4f60\u597d\"},{\"id\":\"c2\",\"text\":\"okay\"}]"
              : "[{\"id\":\"c2\",\"text\":\"\u597d\"}]";
        }
        public void cancel() {}
        public void close() { closed.incrementAndGet(); }
      };
    };
    try (NaturalCaptionTranslator translator = translator(cache, checkpoints, factory)) {
      Map<String, Object> request = request(List.of(Map.of("id", "c1", "text", "Hello"), Map.of("id", "c2", "text", "okay")));
      Map<String, Object> first = run(translator, model, request);
      assertEquals(1, opened.get()); assertEquals(1, closed.get()); assertEquals(2, prompts.size());
      var retry = JsonParser.parseString(prompts.get(1)).getAsJsonObject();
      assertEquals(1, retry.getAsJsonArray("captions").size());
      assertTrue(retry.get("contextBefore").getAsString().contains("Hello"));
      assertTrue(retry.get("contextAfter").getAsString().contains("After"));
      assertEquals(Boolean.TRUE, cue(first, 1).get("valid"));
      assertEquals("\u597d", cue(first, 1).get("text"));
      Map<String, Object> restored = run(translator, model, request);
      assertEquals(first.get("captions"), restored.get("captions"));
      assertEquals(1, opened.get()); assertEquals(2, prompts.size());
    }
  }

  @Test public void absentOkResponseIsNotAcceptedOrResurrectedByCheckpoint() throws Exception {
    File model = directory.newFile("model.litertlm");
    Files.write(model.toPath(), new byte[] { 1 });
    AtomicInteger calls = new AtomicInteger();
    TranslationRuntimeFactory factory = (file, folder, threads, instruction) -> new TranslationRuntime() {
      public String translate(String prompt) { return calls.incrementAndGet() <= 2 ? "[]" : "[{\"id\":\"c1\",\"text\":\"OK\"}]"; }
      public void cancel() {}
      public void close() {}
    };
    try (NaturalCaptionTranslator translator = translator(directory.newFolder("cache"), directory.newFolder("checkpoints"), factory)) {
      var request = request(List.of(Map.of("id", "c1", "text", "OK")));
      assertEquals(Boolean.FALSE, cue(run(translator, model, request), 0).get("valid"));
      assertEquals(2, calls.get());
      assertEquals(Boolean.TRUE, cue(run(translator, model, request), 0).get("valid"));
      assertEquals(3, calls.get());
    }
  }

  @Test public void qualityAllowsNativeAcknowledgementsButRejectsEnglishEchoes() {
    assertFalse(TranslationOutputQuality.needsReview("okay", "\u597d", "zh-Hans"));
    assertFalse(TranslationOutputQuality.needsReview("okay", "OK!", "zh-Hans"));
    assertFalse(TranslationOutputQuality.needsReview("42", "42", "ja"));
    assertFalse(TranslationOutputQuality.needsReview("a name", "\uD842\uDFB7", "zh-Hans"));
    assertTrue(TranslationOutputQuality.needsReview("Hello", "Hello", "zh-Hans"));
    assertTrue(TranslationOutputQuality.needsReview("okay", "okay", "zh-Hans"));
    assertTrue(TranslationOutputQuality.needsReview("okay", "", "zh-Hans"));
    assertFalse(TranslationOutputQuality.needsReview("We already arrived", "我们已经到了", "zh-Hans"));
    assertTrue(TranslationOutputQuality.needsReview("We already arrived", "我們已經到了", "zh-Hans"));
    assertFalse(TranslationOutputQuality.needsReview("We already arrived", "我們已經到了", "zh-Hant"));
    assertTrue(TranslationOutputQuality.needsReview("We already arrived", "我们已经到了", "zh-Hant"));
  }

  @Test public void qualityRejectsMultiCueBleedEvenWhenUnderFormerAbsoluteCap() {
    String source = "positive response on these";
    String bleed = "对该请求给出积极回应。请在 GitHub 查看源代码，在 Play Store 下载应用，通过 CuCoin 完成支付，并核对工资单、税务表格以及前后多条字幕里提到的发布说明、安装步骤、账户恢复流程与客服回复内容，确保所有条目都已翻译完整且没有遗漏。";
    assertTrue(bleed.codePointCount(0, bleed.length()) < 500);
    assertTrue(TranslationOutputQuality.needsReview(source, bleed, "zh-Hans"));
    assertFalse(TranslationOutputQuality.isPlausibleCueTranslation(source, bleed));
    assertFalse(TranslationOutputQuality.needsReview(source, "积极回应", "zh-Hans"));
  }

  private NaturalCaptionTranslator translator(File cache, File checkpoints, TranslationRuntimeFactory factory) {

    return new NaturalCaptionTranslator(new TranslationEnvironment() {
      public File prepareCacheDirectory() { return cache; }
      public File prepareCheckpointDirectory() { return checkpoints; }
      public void verifyDeviceCapacity(File model) {}
    }, factory, (model, cancelled, progress) -> {}, Executors.newSingleThreadExecutor());
  }

  private static Map<String, Object> request(List<Map<String, String>> captions) {
    return Map.of("reuseCheckpoints", true, "repairUnusableOutputs", true, "operations", List.of(Map.of(
        "id", "operation", "sourceLanguage", "en", "targetLanguage", "zh-Hans",
        "batches", List.of(Map.of("captions", captions, "contextBefore", "Before", "contextAfter", "After")))));
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

  @SuppressWarnings("unchecked") private static Map<String, Object> cue(Map<String, Object> result, int index) {
    return ((List<Map<String, Object>>) result.get("captions")).get(index);
  }
}
