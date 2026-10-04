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

  private Map<String,Object> run(File checkpoints, AtomicInteger calls, String output, boolean repair) throws Exception {
    File model = temporary.newFile("test-" + System.nanoTime() + ".litertlm");
    Files.write(model.toPath(), new byte[]{1});
    TranslationRuntimeFactory factory = (m,c,t,s) -> new TranslationRuntime() {
      public boolean supportsStructuredOutput() { return true; }
      public String translate(String prompt, int tokens, boolean structured) {
        assertTrue(structured);
        return translate(prompt);
      }
      public String translate(String prompt) {
        calls.incrementAndGet();
        JsonArray response = new JsonArray();
        for (var element : JsonParser.parseString(prompt).getAsJsonObject().getAsJsonArray("captions")) {
          JsonObject item = new JsonObject();
          item.add("id", element.getAsJsonObject().get("id"));
          item.addProperty("text", output);
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
          "operations", List.of(Map.of("id", "op", "sourceLanguage", "en", "targetLanguage", "fr",
              "batches", List.of(Map.of("captions", List.of(Map.of("id", "cue",
                  "text", "Hello \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb"))))))),
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
