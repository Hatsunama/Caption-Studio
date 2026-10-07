package app.captionstudio.translation;

import static org.junit.Assert.*;
import com.google.gson.JsonArray;
import com.google.gson.JsonParser;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.Test;

public final class TranslationPreservationContractTest {
  @Test public void sharedNativeJsPreservationCorpus() throws Exception {
    try (var input = getClass().getResourceAsStream("/translation-preservation-contract.json")) {
      assertNotNull("shared preservation corpus must be on the test classpath", input);
      JsonArray cases = JsonParser.parseReader(new InputStreamReader(input, StandardCharsets.UTF_8)).getAsJsonArray();
      assertEquals(90, cases.size());
      for (var element : cases) {
        var item = element.getAsJsonObject();
        assertEquals(item.get("name").getAsString(), item.get("preserved").getAsBoolean(),
            TranslationPreservation.preserves(item.get("source").getAsString(), item.get("translated").getAsString()));
      }
    }
  }

  @Test public void sourcePartitionNeverSplitsProtectedLiteralsOrEmojiClusters() {
    String emoji = "\ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb\u0301";
    String url = "https://example.test/" + "a".repeat(700) + "/cafe\u0301";
    String code = "\u0060cafe\u0301_id=\"" + "<".repeat(100) + "\"\u0060";
    String source = "Hello ".repeat(8) + emoji + "\r\n" + url + " Hello " + code + " World";
    List<String> parts = TranslationPreservation.split(source, 60);
    assertEquals(source, String.join("", parts));
    assertTrue(parts.stream().anyMatch(p -> p.equals(url)));
    assertTrue(parts.stream().anyMatch(p -> p.equals(code)));
    assertEquals(1, parts.stream().filter(p -> p.contains(emoji)).count());
    for (String part : parts) assertTrue(TranslationText.wellFormed(part));
  }

  @Test public void integerFormsAreAcceptedWithoutTargetScriptFalsePositive() {
    for (String target : new String[] {"en", "fr", "zh-Hans", "ja", "ar"}) {
      assertEquals(TranslationOutputQuality.Reason.NONE,
          TranslationOutputQuality.classify("42", "\u0664\u0662", target));
    }
    assertEquals(TranslationOutputQuality.Reason.PROTECTED_CONTENT,
        TranslationOutputQuality.classify("42", "\u0664\u0663", "ar"));
  }

  @Test public void lineBreaksSurviveStrictParserBeforeQualityAndCheckpointAcceptance() throws Exception {
    String source = "\r\nHello\n\nWorld\r\n";
    var caption = NaturalCaptionTranslator.parseSingleCaptionRetryResponse(
        "[{\"id\":\"cue\",\"text\":\"\\nBonjour\\n\\nMonde\\n\"}]",
        new NaturalCaptionTranslator.Caption("cue", source));
    assertTrue(caption.valid);
    assertEquals("\nBonjour\n\nMonde\n", caption.text);
    assertFalse(TranslationOutputQuality.needsReview(source, caption.text, "fr"));
  }
  @Test public void seekerStandaloneOperatorQualityAndLexicalBoundaries() {
    String source = "42 https://example.com/\n\n\u0060src/app.ts\u0060 + is ready.";
    String good = "42 https://example.com/\n\n\u0060src/app.ts\u0060 + 已准备好。";
    assertEquals(TranslationOutputQuality.Reason.PROTECTED_CONTENT,
        TranslationOutputQuality.classify(source, good.replace(" +", ""), "zh-Hans"));
    assertEquals(TranslationOutputQuality.Reason.NONE,
        TranslationOutputQuality.classify(source, good, "zh-Hans"));
    assertEquals(TranslationOutputQuality.Reason.SOURCE_ECHO,
        TranslationOutputQuality.classify(source, source, "zh-Hans"));
    assertEquals("Ready   now", TranslationPreservation.translationProse("Ready + now"));
    assertEquals("well-known x+y C++", TranslationPreservation.translationProse("well-known x+y C++"));
    assertFalse(TranslationPreservation.protectedCompositionOnly(source));
  }

  @Test public void seekerRuntimeRejectsDroppedOperatorAndGeneratesTranslatedProse() throws Exception {
    String source = "42 https://example.com/\n\n\u0060src/app.ts\u0060 + is ready.";
    String good = "42 https://example.com/\n\n\u0060src/app.ts\u0060 + 已准备好。";
    for (String answer : new String[] {good.replace(" +", ""), good, source}) {
      java.nio.file.Path directory = java.nio.file.Files.createTempDirectory("operator-contract");
      try {
        java.io.File model = directory.resolve("fake.litertlm").toFile();
        java.nio.file.Files.write(model.toPath(), new byte[] {1});
        var calls = new java.util.concurrent.atomic.AtomicInteger();
        TranslationEnvironment environment = new TranslationEnvironment() {
          public java.io.File prepareCacheDirectory() { return directory.toFile(); }
          public java.io.File prepareCheckpointDirectory() { return directory.toFile(); }
          public void verifyDeviceCapacity(java.io.File file) {}
        };
        TranslationRuntimeFactory factory = (m,c,t,s) -> new TranslationRuntime() {
          public boolean supportsStructuredOutput() { return true; }
          public String translate(String prompt) {
            calls.incrementAndGet();
            JsonArray response = new JsonArray();
            for (var element : JsonParser.parseString(prompt).getAsJsonObject().getAsJsonArray("captions")) {
              var item = new com.google.gson.JsonObject();
              item.add("id", element.getAsJsonObject().get("id"));
              item.addProperty("text", answer);
              response.add(item);
            }
            return response.toString();
          }
          public String translate(String prompt, int tokens, boolean structured) { return translate(prompt); }
          public void cancel() {}
          public void close() {}
        };
        var done = new java.util.concurrent.CountDownLatch(1);
        var result = new java.util.concurrent.atomic.AtomicReference<java.util.Map<String,Object>>();
        var error = new java.util.concurrent.atomic.AtomicReference<String>();
        try (var worker = new NaturalCaptionTranslator(environment, factory, (file,c,p) -> {},
            java.util.concurrent.Executors.newSingleThreadExecutor(), line -> {})) {
          worker.start(model.getAbsolutePath(), java.util.Map.of("requestId", "operator-contract",
              "reuseCheckpoints", true, "repairUnusableOutputs", false,
              "operations", java.util.List.of(java.util.Map.of("id", "op", "sourceLanguage", "en",
                  "targetLanguage", "zh-Hans", "batches", java.util.List.of(java.util.Map.of("captions",
                      java.util.List.of(java.util.Map.of("id", "seeker", "text", source))))))),
              new NaturalCaptionTranslator.Callback() {
                public void onSuccess(java.util.Map<String,Object> value) { result.set(value); done.countDown(); }
                public void onError(String code, String message, Throwable cause) { error.set(code); done.countDown(); }
              });
          assertTrue(done.await(10, java.util.concurrent.TimeUnit.SECONDS));
          assertNull(error.get());
          assertTrue("ordinary prose must invoke generation", calls.get() > 0);
          var cue = (java.util.Map<?,?>)((java.util.List<?>)result.get().get("captions")).get(0);
          boolean accepted = answer.equals(good);
          assertEquals(accepted, cue.get("valid"));
          assertEquals(accepted ? good : "", cue.get("text"));
          assertEquals(accepted ? 1 : 0, directory.toFile().listFiles((d,n) -> n.endsWith(".checkpoint")).length);
        }
      } finally {
        try (var files = java.nio.file.Files.walk(directory)) {
          for (var path : files.sorted(java.util.Comparator.reverseOrder()).toList()) java.nio.file.Files.delete(path);
        }
      }
    }
  }

  @Test public void unspacedChineseOperatorMustPassNativePreservationAndQuality() {
    String[] sources = {"Ready + now", "42 https://example.com/\n\n\u0060src/app.ts\u0060 + is ready."};
    String[] targets = {"现在+已就绪", "42 https://example.com/\n\n\u0060src/app.ts\u0060+已准备好。"};
    for (int i = 0; i < sources.length; i++) {
      assertTrue("exact plus outside opaque spans must survive without target spaces",
          TranslationPreservation.preserves(sources[i], targets[i]));
      assertEquals(TranslationOutputQuality.Reason.NONE,
          TranslationOutputQuality.classify(sources[i], targets[i], "zh-Hans"));
    }
  }

  @Test public void unspacedChineseOperatorMustPassNativeQualityIndependently() {
    assertEquals(TranslationOutputQuality.Reason.NONE,
        TranslationOutputQuality.classify("Ready + now", "现在+已就绪", "zh-Hans"));
  }
}
