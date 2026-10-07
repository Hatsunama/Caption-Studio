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

/** Production acceptance regressions: fake generation, real translator/Gson/checkpoints. */
public final class TranslationPreservationAcceptanceTest {
  @Rule public TemporaryFolder temporary = new TemporaryFolder();

  @Test public void lostProtectedContentCannotPassQualityAcceptance() {
    String[][] pairs = {
      {"Read https://example.test/a?x=2", "Lisez https://example.test/a?x=3"},
      {"Run \u0060user_id=42\u0060 now", "Ex\u00e9cutez \u0060user_id=43\u0060"},
      {"Hello \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb", "Bonjour \ud83d\udc69\u200d\ud83d\udcbb"},
      {"Hello \ud83c\uddfa\ud83c\uddf8", "Bonjour \ud83c\uddec\ud83c\udde7"},
      {"Hello 1\ufe0f\u20e3", "Bonjour 1"},
      {"Hello \u2764\ufe0f", "Bonjour \u2764"},
      {"First\nSecond", "Premier Deuxi\u00e8me"},
    };
    for (String[] pair : pairs) {
      assertTrue("lost protected content was accepted: " + pair[0],
          TranslationOutputQuality.needsReview(pair[0], pair[1], "fr"));
    }
  }

  @Test public void legitimateLocaleChangesAndAcknowledgementsRemainAccepted() {
    String[][] pairs = {
      {"Okay.", "OK!"},
      {"She said \"hello\".", "Elle a dit \u00ab bonjour \u00bb."},
      {"Pay 1,234.50 USD", "Payez 1\u202f234,50 USD"},
      {"Buy 12 items", "Achetez \u0661\u0662 articles"},
      {"Hello\r\nWorld", "Bonjour\nMonde"},
      {"Meet OK Go", "Rencontrez OK Go"},
      {"Read https://example.test/cafe\u0301", "Lisez https://example.test/cafe\u0301"},
    };
    for (String[] pair : pairs) assertFalse(pair[1],
        TranslationOutputQuality.needsReview(pair[0], pair[1], "fr"));
  }

  @Test public void failedProtectedFragmentIsNotAcceptedOrDurablyRestored() throws Exception {
    File checkpoints = temporary.newFolder();
    AtomicInteger firstCalls = new AtomicInteger();
    Map<String,Object> first = run(checkpoints, firstCalls, "Bonjour", false);
    assertEquals("a missing emoji must leave an empty invalid cue", false, cue(first).get("valid"));
    assertEquals("", cue(first).get("text"));
    AtomicInteger nextCalls = new AtomicInteger();
    Map<String,Object> next = run(checkpoints, nextCalls, "Bonjour \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb", false);
    assertEquals("invalid content was restored without generating", 1, nextCalls.get());
    assertEquals(true, cue(next).get("valid"));
    AtomicInteger cachedCalls = new AtomicInteger();
    Map<String,Object> cached = run(checkpoints, cachedCalls, "Must not generate", false);
    assertEquals(0, cachedCalls.get());
    assertEquals(next.get("captions"), cached.get("captions"));
  }

  @Test public void corruptedOldCheckpointMustBeRevalidatedAgainstSource() throws Exception {
    File checkpoints = temporary.newFolder();
    AtomicInteger calls = new AtomicInteger();
    run(checkpoints, calls, "Bonjour \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb", false);
    File[] entries = checkpoints.listFiles((d,n) -> n.endsWith(".checkpoint"));
    assertNotNull(entries);
    assertEquals(1, entries.length);
    String key = entries[0].getName().replace(".checkpoint", "");
    new TranslationCheckpointStore(checkpoints).write(key,
        "[{\"id\":\"fragment\",\"text\":\"Bonjour\"}]");
    AtomicInteger resumedCalls = new AtomicInteger();
    Map<String,Object> resumed = run(checkpoints, resumedCalls,
        "Bonjour \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb", false);
    assertEquals("changed checkpoint must not count as accepted", 1, resumedCalls.get());
    assertEquals(true, cue(resumed).get("valid"));
  }

  @Test public void failedRepairCannotBecomeAcceptedBatchOrCheckpoint() throws Exception {
    File checkpoints = temporary.newFolder();
    AtomicInteger calls = new AtomicInteger();
    Map<String,Object> result = run(checkpoints, calls, "Bonjour", true);
    assertEquals(2, calls.get());
    assertEquals(false, cue(result).get("valid"));
    assertEquals("", cue(result).get("text"));
    File[] entries = checkpoints.listFiles((d,n) -> n.endsWith(".checkpoint"));
    assertNotNull(entries);
    assertEquals(0, entries.length);
  }

  @Test public void successfulPreservationRepairIsCachedAndNeverRegeneratesAcceptedText() throws Exception {
    File directory = temporary.newFolder();
    AtomicInteger calls = new AtomicInteger();
    var result = run(directory, calls, "repair", true);
    assertEquals(2, calls.get());
    assertEquals(true, cue(result).get("valid"));
    assertEquals("Bonjour \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb", cue(result).get("text"));
    AtomicInteger cachedCalls = new AtomicInteger();
    var cached = run(directory, cachedCalls, "Must not generate", true);
    assertEquals(0, cachedCalls.get());
    assertEquals(result.get("captions"), cached.get("captions"));
  }

  @Test public void edgeAndInteriorLineBreaksSurviveFreshAndRestoredCheckpointOutput() throws Exception {
    File directory = temporary.newFolder();
    String source = "\r\nHello\n\nWorld\r\n";
    String translated = "\nBonjour\n\nMonde\n";
    AtomicInteger calls = new AtomicInteger();
    var fresh = runSource(directory, calls, translated, false, source, "fr");
    assertEquals(translated, cue(fresh).get("text"));
    AtomicInteger restoredCalls = new AtomicInteger();
    var restored = runSource(directory, restoredCalls, "Must not generate", false, source, "fr");
    assertEquals(0, restoredCalls.get());
    assertEquals(fresh.get("captions"), restored.get("captions"));
  }

  @Test public void shortDecomposedCodeAndUrlSurviveRuntimeAndCheckpointWithoutNfcMutation() throws Exception {
    String source = "Hello https://example.test/cafe\u0301 \u0060cafe\u0301_id=42\u0060";
    String translated = "Bonjour https://example.test/cafe\u0301 \u0060cafe\u0301_id=42\u0060";
    File directory = temporary.newFolder();
    AtomicInteger calls = new AtomicInteger();
    assertEquals(translated, cue(runSource(directory, calls, translated, false, source, "fr")).get("text"));
    AtomicInteger restored = new AtomicInteger();
    assertEquals(translated, cue(runSource(directory, restored, "Must not generate", false, source, "fr")).get("text"));
    assertEquals(0, restored.get());
  }

  @Test public void oversizedOpaqueLiteralBypassesInferenceAndSurvivesChineseFragmentJoining() throws Exception {
    String url = "https://example.test/" + "a".repeat(700) + "/cafe\u0301";
    String source = "Hello ".repeat(90) + "\r\n" + url + " World";
    AtomicInteger calls = new AtomicInteger();
    var result = runSource(temporary.newFolder(), calls, null, false, source, "zh-Hans");
    assertTrue(calls.get() > 0);
    assertEquals(true, cue(result).get("valid"));
    String text = (String) cue(result).get("text");
    assertTrue(text.contains(url + " "));
    assertTrue(TranslationPreservation.preserves(source, text));
  }

  @Test public void laterTerminalFailureKeepsEarlierAcceptedProtectedBatchDurable() throws Exception {
    File directory = temporary.newFolder();
    File model = temporary.newFile("partial-model.litertlm");
    Files.write(model.toPath(), new byte[]{1});
    String firstSource = "Hello https://example.test/cafe\u0301";
    String secondSource = "World \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb";
    Map<String,Object> request = Map.of("requestId", "partial-preservation", "reuseCheckpoints", true,
        "operations", List.of(Map.of("id", "op", "sourceLanguage", "en", "targetLanguage", "fr",
            "batches", List.of(
                Map.of("captions", List.of(Map.of("id", "one", "text", firstSource))),
                Map.of("captions", List.of(Map.of("id", "two", "text", secondSource)))))));
    TranslationEnvironment environment = new TranslationEnvironment() {
      public File prepareCacheDirectory() { return directory; }
      public File prepareCheckpointDirectory() { return directory; }
      public void verifyDeviceCapacity(File f) {}
    };
    for (int pass = 0; pass < 2; pass++) {
      boolean interruptSecond = pass == 0;
      AtomicInteger calls = new AtomicInteger();
      TranslationRuntimeFactory factory = (m,c,t,s) -> new TranslationRuntime() {
        public boolean supportsStructuredOutput() { return true; }
        public String translate(String prompt) {
          calls.incrementAndGet();
          JsonArray out = new JsonArray();
          for (var element : JsonParser.parseString(prompt).getAsJsonObject().getAsJsonArray("captions")) {
            var input = element.getAsJsonObject();
            String source = input.get("text").getAsString();
            if (interruptSecond && source.equals(secondSource)) throw new IllegalStateException("test generation failed");
            JsonObject item = new JsonObject();
            item.add("id", input.get("id"));
            item.addProperty("text", source.replace("Hello", "Bonjour").replace("World", "Monde"));
            out.add(item);
          }
          return out.toString();
        }
        public String translate(String prompt, int tokens, boolean structured) { assertTrue(structured); return translate(prompt); }
        public void cancel() {}
        public void close() {}
      };
      CountDownLatch done = new CountDownLatch(1);
      AtomicReference<String> error = new AtomicReference<>();
      AtomicReference<Map<String,Object>> result = new AtomicReference<>();
      try (NaturalCaptionTranslator worker = new NaturalCaptionTranslator(environment, factory, (f,c,p) -> {},
          Executors.newSingleThreadExecutor(), line -> {})) {
        worker.start(model.getAbsolutePath(), request, new NaturalCaptionTranslator.Callback() {
          public void onSuccess(Map<String,Object> value) { result.set(value); done.countDown(); }
          public void onError(String code,String message,Throwable cause) { error.set(code); done.countDown(); }
        });
        assertTrue(done.await(10, TimeUnit.SECONDS));
        var first = worker.getAcceptedBatches("partial-preservation").get(0);
        var item = (Map<?,?>)((List<?>)first.get("captions")).get(0);
        assertEquals("Bonjour https://example.test/cafe\u0301", item.get("text"));
        if (interruptSecond) {
          assertEquals(NaturalCaptionTranslator.FAILED, error.get());
          assertEquals(1, worker.getAcceptedBatches("partial-preservation").size());
        } else {
          assertNull(error.get());
          assertEquals(1, calls.get());
          assertEquals(2, ((List<?>)result.get().get("captions")).size());
        }
      }
    }
  }



  @Test public void protectedDataNeitherContaminatesNorSuppliesProseScript() throws Exception {
    try (var input = getClass().getResourceAsStream("/translation-protected-composition.json")) {
      assertNotNull(input);
      var cases = JsonParser.parseReader(new java.io.InputStreamReader(input,
          java.nio.charset.StandardCharsets.UTF_8)).getAsJsonArray();
      for (var element : cases) {
        var item = element.getAsJsonObject();
        if (!item.has("scriptFixture")) continue;
        for (var target : item.getAsJsonArray("targets")) {
          assertEquals(item.get("name").getAsString(),
              item.get("review").getAsBoolean() ? TranslationOutputQuality.Reason.WRONG_SCRIPT
                  : TranslationOutputQuality.Reason.NONE,
              TranslationOutputQuality.classify(item.get("source").getAsString(),
                  item.get("translated").getAsString(), target.getAsString()));
        }
      }
    }
  }

  @Test public void translatedProseWithProtectedScriptSurvivesRuntimeAndReplay() throws Exception {
    String source = "Bring \u0060我們\u0060.";
    String translated = "带上 \u0060我們\u0060。";
    File directory = temporary.newFolder();
    AtomicInteger calls = new AtomicInteger();
    var fresh = runSource(directory, calls, translated, false, source, "zh-Hans");
    assertEquals(true, cue(fresh).get("valid"));
    assertEquals(translated, cue(fresh).get("text"));
    assertEquals(1, calls.get());
    AtomicInteger replayCalls = new AtomicInteger();
    var replay = runSource(directory, replayCalls, "Must not generate", false, source, "zh-Hans");
    assertEquals(fresh.get("captions"), replay.get("captions"));
    assertEquals(0, replayCalls.get());
    AtomicInteger decoyCalls = new AtomicInteger();
    var rejected = runSource(temporary.newFolder(), decoyCalls, "See \u0060東京\u0060.",
        true, "Read \u0060東京\u0060.", "ja");
    assertEquals(false, cue(rejected).get("valid"));
    assertTrue(decoyCalls.get() > 0);
  }

  @Test public void sharedProtectedCompositionQualityParity() throws Exception {
    try (var input = getClass().getResourceAsStream("/translation-protected-composition.json")) {
      assertNotNull(input);
      var cases = JsonParser.parseReader(new java.io.InputStreamReader(input,
          java.nio.charset.StandardCharsets.UTF_8)).getAsJsonArray();
      for (var element : cases) {
        var item = element.getAsJsonObject();
        for (String target : item.has("targets")
            ? java.util.stream.StreamSupport.stream(item.getAsJsonArray("targets").spliterator(), false)
                .map(value -> value.getAsString()).toArray(String[]::new)
            : new String[] {"pl", "zh-Hans", "ar", "ja"}) {
          assertEquals(item.get("name").getAsString() + ": " + target,
              item.get("review").getAsBoolean(), TranslationOutputQuality.needsReview(
                  item.get("source").getAsString(), item.get("translated").getAsString(), target));
        }
      }
    }
  }

  @Test public void samsungCompositionBypassesGenerationAndReplaysAcceptedBatch() throws Exception {
    String source = "ok https://example.com/ \u0060src/app.ts\u0060 \ud83d\ude00";
    File directory = temporary.newFolder();
    AtomicInteger calls = new AtomicInteger();
    var fresh = runSource(directory, calls, source, true, source, "pl");
    assertEquals(true, cue(fresh).get("valid"));
    assertEquals(source, cue(fresh).get("text"));
    assertEquals("cue", cue(fresh).get("id"));
    assertEquals("no needless model inference for invariant composition", 0, calls.get());
    AtomicInteger replayCalls = new AtomicInteger();
    var replay = runSource(directory, replayCalls, "Must not generate", true, source, "pl");
    assertEquals(fresh.get("captions"), replay.get("captions"));
    assertEquals(0, replayCalls.get());
  }

  @Test public void literalCompositionBypassesGenerationForEveryTarget() throws Exception {
    String source = "https://example.com/ \u0060src/app.ts\u0060 \ud83d\ude00";
    for (String target : new String[] {"pl", "zh-Hans", "ar", "ja"}) {
      AtomicInteger calls = new AtomicInteger();
      var result = runSource(temporary.newFolder(), calls, "Must not generate", true, source, target);
      assertEquals(true, cue(result).get("valid"));
      assertEquals(source, cue(result).get("text"));
      assertEquals(0, calls.get());
    }
  }

  @Test public void ordinaryProseWithLiteralsStillGeneratesAndRejectsEcho() throws Exception {
    String source = "Read https://example.com/ \u0060src/app.ts\u0060 \ud83d\ude00";
    AtomicInteger calls = new AtomicInteger();
    var result = runSource(temporary.newFolder(), calls, source, true, source, "pl");
    assertTrue(calls.get() > 0);
    assertEquals(false, cue(result).get("valid"));
    assertEquals("", cue(result).get("text"));
  }


  @Test public void cancellationAfterInvariantBatchRetainsReplayAndResumeStillTranslatesProse() throws Exception {
    for (String invariant : new String[] {
        "ok https://example.com/ \u0060src/app.ts\u0060 \ud83d\ude00",
        "42 https://example.com/ \u0060src/app.ts\u0060 \ud83d\ude00",
        "+ https://example.com/ \u0060code\u0060 \ud83d\ude00"}) {
    File directory = temporary.newFolder();
    File model = temporary.newFile("composition-cancel-" + System.nanoTime() + ".litertlm");
    Files.write(model.toPath(), new byte[]{1});
    Map<String,Object> request = Map.of("requestId", "composition-cancel", "reuseCheckpoints", true,
        "operations", List.of(Map.of("id", "op", "sourceLanguage", "en", "targetLanguage", "pl",
            "batches", List.of(
                Map.of("captions", List.of(Map.of("id", "data", "text", invariant)),
                    "contextAfter", "Hello"),
                Map.of("captions", List.of(Map.of("id", "prose", "text", "Hello")),
                    "contextBefore", invariant)))));
    TranslationEnvironment environment = new TranslationEnvironment() {
      public File prepareCacheDirectory() { return directory; }
      public File prepareCheckpointDirectory() { return directory; }
      public void verifyDeviceCapacity(File f) {}
    };
    for (int pass = 0; pass < 2; pass++) {
      boolean interrupt = pass == 0;
      AtomicInteger opens = new AtomicInteger();
      AtomicInteger calls = new AtomicInteger();
      TranslationRuntimeFactory factory = (m,c,t,s) -> {
        opens.incrementAndGet();
        return new TranslationRuntime() {
          public boolean supportsStructuredOutput() { return true; }
          public String translate(String prompt) {
            calls.incrementAndGet();
            var payload = JsonParser.parseString(prompt).getAsJsonObject();
            assertEquals(invariant, payload.get("contextBefore").getAsString());
            var inputs = payload.getAsJsonArray("captions");
            assertEquals(1, inputs.size());
            assertEquals("Hello", inputs.get(0).getAsJsonObject().get("text").getAsString());
            JsonObject item = new JsonObject();
            item.add("id", inputs.get(0).getAsJsonObject().get("id"));
            item.addProperty("text", "Czesc");
            JsonArray output = new JsonArray();
            output.add(item);
            return output.toString();
          }
          public String translate(String prompt, int tokens, boolean structured, String schema) {
            assertTrue(structured);
            assertNotNull(schema);
            return translate(prompt);
          }
          public void cancel() {}
          public void close() {}
        };
      };
      CountDownLatch done = new CountDownLatch(1);
      AtomicReference<String> error = new AtomicReference<>();
      AtomicReference<Map<String,Object>> result = new AtomicReference<>();
      try (NaturalCaptionTranslator worker = new NaturalCaptionTranslator(environment, factory,
          (f,c,p) -> {}, Executors.newSingleThreadExecutor(), line -> {})) {
        worker.start(model.getAbsolutePath(), request, new NaturalCaptionTranslator.Callback() {
          public void onSuccess(Map<String,Object> value) { result.set(value); done.countDown(); }
          public void onError(String code, String message, Throwable cause) { error.set(code); done.countDown(); }
          public void onBatchAccepted(Map<String,Object> batch) {
            if (interrupt) worker.cancel();
          }
        });
        assertTrue(done.await(10, TimeUnit.SECONDS));
        var accepted = worker.getAcceptedBatches("composition-cancel");
        assertEquals(interrupt ? 1 : 2, accepted.size());
        var first = (Map<?,?>)((List<?>)accepted.get(0).get("captions")).get(0);
        assertEquals("data", first.get("id"));
        assertEquals(invariant, first.get("text"));
        assertEquals(true, first.get("valid"));
        if (interrupt) {
          assertEquals(NaturalCaptionTranslator.CANCELLED, error.get());
          assertNull(result.get());
          assertEquals(0, opens.get());
          assertEquals(0, calls.get());
        } else {
          assertNull(error.get());
          assertEquals(1, opens.get());
          assertEquals(1, calls.get());
          assertEquals(2, ((List<?>)result.get().get("captions")).size());
        }
      }
    }
    }
  }


  @Test public void numericAndSymbolCompositionsBypassGenerationAndReplayForEveryTarget() throws Exception {
    for (String source : new String[] {
        "42 https://example.com/ \u0060src/app.ts\u0060 \ud83d\ude00",
        "+ https://example.com/ \u0060code\u0060 \ud83d\ude00",
        "4 2 https://example.com/ \u0060src/app.ts\u0060 \ud83d\ude00",
        "+42 / -7 = 35 https://example.com/ \u0060src/app.ts\u0060 \ud83d\ude00"}) {
      for (String target : new String[] {"pl", "zh-Hans", "ar", "ja"}) {
        File directory = temporary.newFolder();
        AtomicInteger calls = new AtomicInteger();
        var first = runSource(directory, calls, source, true, source, target);
        assertEquals(source + ": " + target, true, cue(first).get("valid"));
        assertEquals(source, cue(first).get("text"));
        assertEquals("cue", cue(first).get("id"));
        assertEquals("metadata needs no inference", 0, calls.get());
        AtomicInteger replayCalls = new AtomicInteger();
        var replay = runSource(directory, replayCalls, "Must not generate", true, source, target);
        assertEquals(first.get("captions"), replay.get("captions"));
        assertEquals(0, replayCalls.get());
      }
    }
  }

  private Map<String,Object> run(File checkpoints, AtomicInteger calls, String output, boolean repair) throws Exception {
    return runSource(checkpoints, calls, output, repair, "Hello \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb", "fr");
  }

  private Map<String,Object> runSource(File checkpoints, AtomicInteger calls, String output, boolean repair, String source, String target) throws Exception {
    File model = temporary.newFile("test-" + System.nanoTime() + ".litertlm");
    Files.write(model.toPath(), new byte[]{1});
    TranslationRuntimeFactory factory = (m,c,t,s) -> new TranslationRuntime() {
      public boolean supportsStructuredOutput() { return true; }
      public String translate(String prompt, int tokens, boolean structured) {
        assertTrue(structured);
        return translate(prompt);
      }
      public String translate(String prompt) {
        int call = calls.incrementAndGet();
        JsonArray response = new JsonArray();
        for (var element : JsonParser.parseString(prompt).getAsJsonObject().getAsJsonArray("captions")) {
          JsonObject item = new JsonObject();
          item.add("id", element.getAsJsonObject().get("id"));
          String sourceText = element.getAsJsonObject().get("text").getAsString();
          String answer = output;
          if (output == null || ("repair".equals(output) && call > 1)) {
            answer = sourceText.replace("Hello", target.equals("zh-Hans") ? "\u4f60\u597d" : "Bonjour")
                .replace("World", target.equals("zh-Hans") ? "\u4e16\u754c" : "Monde");
          } else if ("repair".equals(output)) answer = "Bonjour";
          item.addProperty("text", answer);
          response.add(item);
        }
        return response.toString();
      }
      public void cancel() {}
      public void close() {}
    };
    TranslationEnvironment environment = new TranslationEnvironment() {
      public File prepareCacheDirectory() { return checkpoints; }
      public File prepareCheckpointDirectory() { return checkpoints; }
      public void verifyDeviceCapacity(File f) {}
    };
    CountDownLatch done = new CountDownLatch(1);
    AtomicReference<Map<String,Object>> value = new AtomicReference<>();
    AtomicReference<String> failure = new AtomicReference<>();
    List<Map<String,Object>> accepted = new ArrayList<>();
    try (NaturalCaptionTranslator worker = new NaturalCaptionTranslator(environment, factory,
        (f,c,p) -> {}, Executors.newSingleThreadExecutor(), line -> {})) {
      worker.start(model.getAbsolutePath(), Map.of("requestId", "preservation-test",
          "reuseCheckpoints", true, "repairUnusableOutputs", repair,
          "operations", List.of(Map.of("id", "op", "sourceLanguage", "en", "targetLanguage", target,
              "batches", List.of(Map.of("captions", List.of(Map.of("id", "cue",
                  "text", source))))))),
          new NaturalCaptionTranslator.Callback() {
            public void onSuccess(Map<String,Object> result) { value.set(result); done.countDown(); }
            public void onError(String code,String message,Throwable cause) { failure.set(code); done.countDown(); }
            public void onBatchAccepted(Map<String,Object> batch) { accepted.add(batch); }
          });
      assertTrue("translator did not finish", done.await(10,TimeUnit.SECONDS));
      assertNull(failure.get());
      assertEquals(1, accepted.size());
      assertEquals(value.get().get("captions"), accepted.get(0).get("captions"));
      return value.get();
    }
  }

  private Map<?,?> cue(Map<String,Object> result) {
    return (Map<?,?>)((List<?>)result.get("captions")).get(0);
  }
}
