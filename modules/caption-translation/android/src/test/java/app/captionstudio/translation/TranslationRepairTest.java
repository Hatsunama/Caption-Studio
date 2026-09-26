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
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class TranslationRepairTest {
  @Rule public TemporaryFolder directory = new TemporaryFolder();

  @Test public void translatesIsolatedCuesInOneEngineAndRestoresWithoutReloading() throws Exception {
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
          JsonArray output = new JsonArray();
          for (var element : JsonParser.parseString(prompt).getAsJsonObject().getAsJsonArray("captions")) {
            JsonObject item = new JsonObject();
            String id = element.getAsJsonObject().get("id").getAsString();
            item.addProperty("id", id);
            item.addProperty("text", id.equals("c1") ? "\u4f60\u597d" : "\u597d");
            output.add(item);
          }
          return output.toString();
        }
        public void cancel() {}
        public void close() { closed.incrementAndGet(); }
      };
    };
    try (NaturalCaptionTranslator translator = translator(cache, checkpoints, factory)) {
      Map<String, Object> request = request(List.of(Map.of("id", "c1", "text", "Hello"), Map.of("id", "c2", "text", "okay")));
      Map<String, Object> first = run(translator, model, request);
      assertEquals(1, opened.get()); assertEquals(1, closed.get()); assertEquals(1, prompts.size());
      var batch = JsonParser.parseString(prompts.get(0)).getAsJsonObject();
      assertEquals(2, batch.getAsJsonArray("captions").size());
      assertEquals(Boolean.TRUE, cue(first, 1).get("valid"));
      assertEquals("\u597d", cue(first, 1).get("text"));
      Map<String, Object> restored = run(translator, model, request);
      assertEquals(first.get("captions"), restored.get("captions"));
      assertEquals(1, opened.get()); assertEquals(1, prompts.size());
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
    assertFalse(TranslationOutputQuality.needsReview("okay", "okay", "zh-Hans"));
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

  @Test public void qualityKeepsTraditionalTaiAndRejectsBorrowedOkForLongerCues() {
    assertFalse(TranslationOutputQuality.needsReview("I live in Taiwan", "我住在台灣", "zh-Hant"));
    assertFalse(TranslationOutputQuality.needsReview("Five kilometers", "五公里", "zh-Hant"));
    assertTrue(TranslationOutputQuality.needsReview("Please bring the documents tomorrow", "OK", "fr"));
    assertFalse(TranslationOutputQuality.needsReview("Okay.", "OK!", "fr"));
    assertFalse(TranslationOutputQuality.needsReview("Meet OK Go tonight", "Rencontrez OK Go ce soir", "fr"));
  }

  @Test public void changedContextOrNeighborRegeneratesButRenamedIdsRestoreDistinctPositions() throws Exception {
    File model = directory.newFile("context-model.litertlm");
    Files.write(model.toPath(), new byte[] { 1 });
    AtomicInteger calls = new AtomicInteger();
    TranslationRuntimeFactory factory = (file, folder, threads, instruction) -> new TranslationRuntime() {
      public String translate(String prompt) {
        calls.incrementAndGet();
        JsonArray output = new JsonArray();
        int index = 0;
        for (var element : JsonParser.parseString(prompt).getAsJsonObject().getAsJsonArray("captions")) {
          JsonObject item = new JsonObject();
          item.addProperty("id", element.getAsJsonObject().get("id").getAsString());
          item.addProperty("text", index++ == 0 ? "\u4f60\u597d" : "\u60a8\u597d");
          output.add(item);
        }
        return output.toString();
      }
      public void cancel() {}
      public void close() {}
    };
    try (NaturalCaptionTranslator translator = translator(directory.newFolder(), directory.newFolder(), factory)) {
      var captions = List.of(Map.of("id", "c1", "text", "Hello"), Map.of("id", "c2", "text", "Hello"));
      var first = run(translator, model, request(captions));
      assertEquals(Boolean.TRUE, cue(first, 0).get("valid"));
      assertEquals(Boolean.TRUE, cue(first, 1).get("valid"));
      var renamed = run(translator, model, request(List.of(
          Map.of("id", "new1", "text", "Hello"), Map.of("id", "new2", "text", "Hello"))));
      assertEquals(1, calls.get());
      assertEquals("new1", cue(renamed, 0).get("id"));
      assertEquals("\u4f60\u597d", cue(renamed, 0).get("text"));
      assertEquals("\u60a8\u597d", cue(renamed, 1).get("text"));
      run(translator, model, request(captions, "Changed before", "After"));
      assertEquals(2, calls.get());
      run(translator, model, request(captions, "Before", "Changed after"));
      assertEquals(3, calls.get());
      run(translator, model, request(List.of(
          Map.of("id", "c1", "text", "Hello"), Map.of("id", "c2", "text", "Hello there"))));
      assertEquals(4, calls.get());
    }
  }

  @Test public void directSingleCueRecoveryAndOptionalRetryKeepNeighborContextAndBoundedCalls() throws Exception {
    File model = directory.newFile("isolation-model.litertlm");
    Files.write(model.toPath(), new byte[] { 1 });
    for (boolean repair : new boolean[] { false, true }) {
      List<String> prompts = new ArrayList<>();
      TranslationRuntimeFactory factory = (file, folder, threads, instruction) -> new TranslationRuntime() {
        public String translate(String prompt) {
          prompts.add(prompt);
          JsonObject input = JsonParser.parseString(prompt).getAsJsonObject();
          JsonArray captions = input.getAsJsonArray("captions");
          if (captions.size() > 1 || (repair && !input.has("retry"))) return "[]";
          String id = captions.get(0).getAsJsonObject().get("id").getAsString();
          return "[{\"id\":\"" + id + "\",\"text\":\"\u4f60\u597d\"}]";
        }
        public void cancel() {}
        public void close() {}
      };
      try (NaturalCaptionTranslator translator = translator(directory.newFolder(), directory.newFolder(), factory)) {
        Map<String, Object> input = new java.util.LinkedHashMap<>(request(List.of(
            Map.of("id", "c1", "text", "Hello"), Map.of("id", "c2", "text", "World"))));
        input.put("repairUnusableOutputs", repair);
        var result = run(translator, model, input);
        assertEquals(Boolean.TRUE, cue(result, 0).get("valid"));
        assertEquals(Boolean.TRUE, cue(result, 1).get("valid"));
        assertEquals(3, prompts.size());
        for (int index = 1; index < prompts.size(); index++) {
          JsonObject prompt = JsonParser.parseString(prompts.get(index)).getAsJsonObject();
          assertEquals(1, prompt.getAsJsonArray("captions").size());
          String id = prompt.getAsJsonArray("captions").get(0).getAsJsonObject().get("id").getAsString();
          assertEquals("Before", prompt.get("contextBefore").getAsString());
          assertEquals("After", prompt.get("contextAfter").getAsString());
          assertEquals(id.equals("c1") ? "Before" : "Before\nHello",
              prompt.getAsJsonObject("sourceNeighbors").get("before").getAsString());
          assertEquals(id.equals("c1") ? "World\nAfter" : "After",
              prompt.getAsJsonObject("sourceNeighbors").get("after").getAsString());
          assertEquals(index == 1 ? "c1" : "c2", id);
          assertEquals(repair, prompt.has("retry"));
        }
      }
    }
  }

  @Test public void partiallyRestoredBatchKeepsCachedNeighborAsContext() throws Exception {
    File model = directory.newFile("partial-model.litertlm");
    Files.write(model.toPath(), new byte[] { 1 });
    AtomicInteger calls = new AtomicInteger();
    List<String> prompts = new ArrayList<>();
    TranslationRuntimeFactory factory = (file, folder, threads, instruction) -> new TranslationRuntime() {
      public String translate(String prompt) {
        prompts.add(prompt);
        int call = calls.incrementAndGet();
        JsonArray captions = JsonParser.parseString(prompt).getAsJsonObject().getAsJsonArray("captions");
        if (captions.size() > 1 || call == 3) return "[]";
        String id = captions.get(0).getAsJsonObject().get("id").getAsString();
        return "[{\"id\":\"" + id + "\",\"text\":\"\u4f60\u597d\"}]";
      }
      public void cancel() {}
      public void close() {}
    };
    try (NaturalCaptionTranslator translator = translator(directory.newFolder(), directory.newFolder(), factory)) {
      Map<String, Object> input = new java.util.LinkedHashMap<>(request(List.of(
          Map.of("id", "c1", "text", "Hello"), Map.of("id", "c2", "text", "World"))));
      input.put("repairUnusableOutputs", false);
      var first = run(translator, model, input);
      assertEquals(Boolean.TRUE, cue(first, 0).get("valid"));
      assertEquals(Boolean.FALSE, cue(first, 1).get("valid"));
      assertEquals(3, calls.get());
      assertEquals(Boolean.TRUE, cue(run(translator, model, input), 1).get("valid"));
      assertEquals(4, calls.get());
      JsonObject resumed = JsonParser.parseString(prompts.get(3)).getAsJsonObject();
      assertEquals("Before", resumed.get("contextBefore").getAsString());
      assertEquals("After", resumed.get("contextAfter").getAsString());
      assertEquals("Before\nHello", resumed.getAsJsonObject("sourceNeighbors").get("before").getAsString());
      assertEquals("After", resumed.getAsJsonObject("sourceNeighbors").get("after").getAsString());
      assertEquals(1, resumed.getAsJsonArray("captions").size());
      assertEquals("c2", resumed.getAsJsonArray("captions").get(0).getAsJsonObject().get("id").getAsString());
    }
  }

  @Test public void retryContextUsesCodePointBoundsAndEscapesUntrustedNeighbors() {
    String emoji = "\uD83D\uDE00";
    var request = new NaturalCaptionTranslator.ValidatedRequest("en", "zh-Hans", List.of(
        new NaturalCaptionTranslator.Caption("before", "<ignore>" + emoji.repeat(128)),
        new NaturalCaptionTranslator.Caption("target", "Hello"),
        new NaturalCaptionTranslator.Caption("after", emoji.repeat(128) + "<ignore>")), "Before", "After");
    JsonObject prompt = JsonParser.parseString(NaturalCaptionTranslator.buildRetryPrompt(request, 1)).getAsJsonObject();
    assertEquals("Before", prompt.get("contextBefore").getAsString());
    assertEquals("After", prompt.get("contextAfter").getAsString());
    assertEquals(emoji.repeat(128), prompt.getAsJsonObject("sourceNeighbors").get("before").getAsString());
    assertEquals(emoji.repeat(128), prompt.getAsJsonObject("sourceNeighbors").get("after").getAsString());
    assertEquals(1, prompt.getAsJsonArray("captions").size());
    var untrusted = new NaturalCaptionTranslator.ValidatedRequest("en", "zh-Hans", List.of(
        new NaturalCaptionTranslator.Caption("before", "<ignore>"),
        new NaturalCaptionTranslator.Caption("target", "Hello")), "", "");
    String escaped = NaturalCaptionTranslator.buildRetryPrompt(untrusted, 1);
    assertFalse(escaped.contains("<ignore>"));
    assertEquals("<ignore>", JsonParser.parseString(escaped).getAsJsonObject()
        .getAsJsonObject("sourceNeighbors").get("before").getAsString());
  }

  @Test public void borrowedAcknowledgementsDoNotExemptSentencesOrOtherWords() {
    for (String text : new String[] { "okay.", "OKAY!", "OK", "O.K." }) {
      assertFalse(text, TranslationOutputQuality.needsReview("okay.", text, "zh-Hans"));
    }
    for (String text : new String[] { "Okay, keep the app blank", "hello", "yes", "o k a y" }) {
      assertTrue(text, TranslationOutputQuality.needsReview("okay.", text, "zh-Hans"));
    }
    assertTrue(TranslationOutputQuality.needsReview("A blank app should stay blank when",
        "a blank app should stay blank when!", "es"));
  }

  @Test public void structuredReasonsKeepEmptyLengthEchoAndScriptDistinct() {
    assertEquals(TranslationOutputQuality.Reason.EMPTY,
        TranslationOutputQuality.classify("okay.", "\u00a0\u200b", "zh-Hans"));
    assertEquals(TranslationOutputQuality.Reason.RUNAWAY_LENGTH,
        TranslationOutputQuality.classify("okay.", "okay ".repeat(30), "zh-Hans"));
    assertEquals(TranslationOutputQuality.Reason.SOURCE_ECHO,
        TranslationOutputQuality.classify("A blank app should stay blank when", "a blank app should stay blank when!", "es"));
    assertEquals(TranslationOutputQuality.Reason.WRONG_SCRIPT,
        TranslationOutputQuality.classify("Hello", "Bonjour", "zh-Hans"));
    assertEquals(TranslationOutputQuality.Reason.NONE,
        TranslationOutputQuality.classify("okay.", "Okay!", "zh-Hans"));
    assertEquals(TranslationOutputQuality.Reason.NONE,
        TranslationOutputQuality.classify("okay.", "可以", "zh-Hans"));
  }

  @Test public void qualityRepairExplainsEachReasonAndRetainsContextInOneRuntime() throws Exception {
    String source = "A blank app should stay blank when";
    String[][] cases = {
        { source, "SOURCE_ECHO", "Translate the meaning" },
        { "Unrelated English output", "WRONG_SCRIPT", "writing system" },
        { "這個應用應該保持空白", "WRONG_SCRIPT", "writing system" },
        { "", "EMPTY", "non-empty" },
        { "字".repeat(180), "RUNAWAY_LENGTH", "only this cue" }
    };
    File model = directory.newFile("quality-model.litertlm");
    Files.write(model.toPath(), new byte[] { 1 });
    for (String[] scenario : cases) {
      AtomicInteger opened = new AtomicInteger();
      AtomicInteger closed = new AtomicInteger();
      List<String> prompts = new ArrayList<>();
      List<String> logs = new ArrayList<>();
      TranslationRuntimeFactory factory = (file, folder, threads, instruction) -> {
        opened.incrementAndGet();
        return new TranslationRuntime() {
          public String translate(String prompt) {
            prompts.add(prompt);
            JsonObject input = JsonParser.parseString(prompt).getAsJsonObject();
            JsonArray output = new JsonArray();
            for (var value : input.getAsJsonArray("captions")) {
              JsonObject item = new JsonObject();
              String id = value.getAsJsonObject().get("id").getAsString();
              item.addProperty("id", id);
              item.addProperty("text", id.equals("cue29") && prompts.size() == 1
                  ? scenario[0] : "空白应用应保持空白");
              output.add(item);
            }
            return output.toString();
          }
          public void cancel() {}
          public void close() { closed.incrementAndGet(); }
        };
      };
      try (NaturalCaptionTranslator translator = translator(directory.newFolder(), directory.newFolder(), factory, logs::add)) {
        var result = run(translator, model, request(List.of(
            Map.of("id", "neighbor", "text", "Previous source cue"),
            Map.of("id", "cue29", "text", source))));
        assertEquals(Boolean.TRUE, cue(result, 1).get("valid"));
        assertEquals(2, prompts.size());
        assertEquals(1, opened.get()); assertEquals(1, closed.get());
        JsonObject retry = JsonParser.parseString(prompts.get(1)).getAsJsonObject();
        assertEquals("translate_caption_batch", retry.get("task").getAsString());
        assertEquals(1, retry.getAsJsonArray("captions").size());
        assertEquals("cue29", retry.getAsJsonArray("captions").get(0).getAsJsonObject().get("id").getAsString());
        assertEquals("Before", retry.get("contextBefore").getAsString());
        assertEquals("After", retry.get("contextAfter").getAsString());
        assertEquals("Before\nPrevious source cue", retry.getAsJsonObject("sourceNeighbors").get("before").getAsString());
        assertEquals("After", retry.getAsJsonObject("sourceNeighbors").get("after").getAsString());
        assertTrue("Missing structured repair for " + scenario[1], retry.has("repair"));
        JsonObject repair = retry.getAsJsonObject("repair");
        assertEquals(scenario[1], repair.get("reason").getAsString());
        assertTrue(repair.get("guidance").getAsString().contains(scenario[2]));
        assertTrue(repair.get("guidance").getAsString().contains("exactly two string fields"));
        assertTrue(logs.toString(), logs.stream().anyMatch(line -> line.contains("qualityReason=" + scenario[1])));
        for (String line : logs) {
          assertFalse(line.contains(source)); assertFalse(line.contains("cue29"));
          assertFalse(line.contains("Previous source cue")); assertFalse(line.contains("Unrelated English output"));
          assertFalse(line.contains("空白"));
        }
      }
    }
  }

  @Test public void repairDropsOversizedNeighborsButKeepsQualityReason() throws Exception {
    File model = directory.newFile("capacity-model.litertlm");
    Files.write(model.toPath(), new byte[] { 1 });
    List<String> prompts = new ArrayList<>();
    TranslationRuntimeFactory factory = (file, folder, threads, instruction) -> new TranslationRuntime() {
      public String translate(String prompt) {
        prompts.add(prompt);
        JsonObject input = JsonParser.parseString(prompt).getAsJsonObject();
        String id = input.getAsJsonArray("captions").get(0).getAsJsonObject().get("id").getAsString();
        return "[{\"id\":\"" + id + "\",\"text\":\"" + (input.has("retry") ? "你好" : "") + "\"}]";
      }
      public void cancel() {}
      public void close() {}
    };
    try (NaturalCaptionTranslator translator = translator(directory.newFolder(), directory.newFolder(), factory)) {
      var result = run(translator, model, request(List.of(
          Map.of("id", "before", "text", "<".repeat(128)),
          Map.of("id", "target", "text", "Hello " + "please ".repeat(40)),
          Map.of("id", "after", "text", "<".repeat(128)))));
      assertEquals(Boolean.TRUE, cue(result, 1).get("valid"));
      assertEquals(2, prompts.size());
      JsonObject retry = JsonParser.parseString(prompts.get(1)).getAsJsonObject();
      assertEquals("EMPTY", retry.getAsJsonObject("repair").get("reason").getAsString());
      assertEquals("", retry.get("contextBefore").getAsString());
      assertEquals("", retry.get("contextAfter").getAsString());
      assertEquals("", retry.getAsJsonObject("sourceNeighbors").get("before").getAsString());
      assertEquals("", retry.getAsJsonObject("sourceNeighbors").get("after").getAsString());
    }
  }

  @Test public void persistentQualityRejectionStaysInvalidAfterOneRepairAndIsNotCached() throws Exception {
    File model = directory.newFile("echo-model.litertlm");
    Files.write(model.toPath(), new byte[] { 1 });
    AtomicInteger calls = new AtomicInteger();
    List<String> logs = new ArrayList<>();
    TranslationRuntimeFactory factory = (file, folder, threads, instruction) -> new TranslationRuntime() {
      public String translate(String prompt) {
        calls.incrementAndGet();
        return "[{\"id\":\"cue29\",\"text\":\"A blank app should stay blank when\"}]";
      }
      public void cancel() {}
      public void close() {}
    };
    try (NaturalCaptionTranslator translator = translator(directory.newFolder(), directory.newFolder(), factory, logs::add)) {
      var input = request(List.of(Map.of("id", "cue29", "text", "A blank app should stay blank when")));
      for (int runIndex = 1; runIndex <= 2; runIndex++) {
        var rejected = cue(run(translator, model, input), 0);
        assertEquals(Boolean.FALSE, rejected.get("valid"));
        assertEquals("", rejected.get("text"));
        assertEquals("QUALITY_REVIEW", rejected.get("failureReason"));
        assertEquals(2 * runIndex, calls.get());
      }
      assertTrue(logs.stream().anyMatch(line -> line.contains("stage=REPAIR") && line.contains("qualityReason=SOURCE_ECHO")));
    }
  }

  private NaturalCaptionTranslator translator(File cache, File checkpoints, TranslationRuntimeFactory factory) {
    return translator(cache, checkpoints, factory, line -> {});
  }

  private NaturalCaptionTranslator translator(File cache, File checkpoints, TranslationRuntimeFactory factory,
      java.util.function.Consumer<String> diagnostics) {

    return new NaturalCaptionTranslator(new TranslationEnvironment() {
      public File prepareCacheDirectory() { return cache; }
      public File prepareCheckpointDirectory() { return checkpoints; }
      public void verifyDeviceCapacity(File model) {}
    }, factory, (model, cancelled, progress) -> {}, Executors.newSingleThreadExecutor(), diagnostics);
  }

  private static Map<String, Object> request(List<Map<String, String>> captions) {
    return request(captions, "Before", "After");
  }

  private static Map<String, Object> request(List<Map<String, String>> captions, String before, String after) {
    return Map.of("reuseCheckpoints", true, "repairUnusableOutputs", true, "operations", List.of(Map.of(
        "id", "operation", "sourceLanguage", "en", "targetLanguage", "zh-Hans",
        "batches", List.of(Map.of("captions", captions, "contextBefore", before, "contextAfter", after)))));
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
