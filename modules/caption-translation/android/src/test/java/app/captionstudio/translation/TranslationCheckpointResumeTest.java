package app.captionstudio.translation;

import static org.junit.Assert.*;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.File;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class TranslationCheckpointResumeTest {
  @Rule public TemporaryFolder temporary = new TemporaryFolder();

  @Test public void cancelledSessionResumesAfterWorkerRecreationWithoutRegeneratingCompletedBatch() throws Exception {
    File directory = temporary.newFolder();
    File model = temporary.newFile("model.litertlm");
    Files.write(model.toPath(), new byte[] { 1 });
    TranslationEnvironment environment = new TranslationEnvironment() {
      public File prepareCacheDirectory() { return directory; }
      public File prepareCheckpointDirectory() { return directory; }
      public void verifyDeviceCapacity(File file) { }
    };
    FakeFactory interrupted = new FakeFactory(true);
    try (NaturalCaptionTranslator worker = worker(environment, interrupted)) {
      Result result = new Result();
      worker.start(model.getAbsolutePath(), request(true), result);
      assertTrue(interrupted.secondStarted.await(10, TimeUnit.SECONDS));
      worker.cancel();
      result.await();
      assertEquals(NaturalCaptionTranslator.CANCELLED, result.error);
    }

    FakeFactory resumed = new FakeFactory(false);
    try (NaturalCaptionTranslator worker = worker(environment, resumed)) {
      Result result = new Result();
      worker.start(model.getAbsolutePath(), request(true), result);
      result.await();
      assertNull(result.error);
      assertEquals(2, ((List<?>) result.value.get("captions")).size());
      assertEquals(1, resumed.generated.get());
      assertEquals(1, resumed.opened.get());
    }

    FakeFactory cached = new FakeFactory(false);
    try (NaturalCaptionTranslator worker = worker(environment, cached)) {
      Result result = new Result();
      worker.start(model.getAbsolutePath(), request(true), result);
      result.await();
      assertNull(result.error);
      assertEquals(0, cached.generated.get());
      assertEquals(0, cached.opened.get());
      // Quality-repair requests must bypass previous outputs, including echoes.
      Result repair = new Result();
      worker.start(model.getAbsolutePath(), request(false), repair);
      repair.await();
      assertNull(repair.error);
      assertEquals(2, cached.generated.get());
    }
  }

  private NaturalCaptionTranslator worker(TranslationEnvironment environment, FakeFactory factory) {
    return new NaturalCaptionTranslator(environment, factory, (file, cancelled, progress) -> { },
        Executors.newSingleThreadExecutor());
  }

  private Map<String, Object> request(boolean reuse) {
    Map<String, Object> request = new LinkedHashMap<>();
    request.put("reuseCheckpoints", reuse);
    request.put("operations", List.of(Map.of("id", "translate", "sourceLanguage", "en", "targetLanguage", "zh-Hans",
        "batches", List.of(
            Map.of("captions", List.of(Map.of("id", "one", "text", "Hello")), "contextAfter", "World"),
            Map.of("captions", List.of(Map.of("id", "two", "text", "World")), "contextBefore", "Hello")))));
    return request;
  }

  private static final class Result implements NaturalCaptionTranslator.Callback {
    final CountDownLatch done = new CountDownLatch(1);
    Map<String, Object> value;
    String error;
    public void onSuccess(Map<String, Object> value) { this.value = value; done.countDown(); }
    public void onError(String code, String message, Throwable cause) { error = code; done.countDown(); }
    void await() throws Exception { assertTrue("worker did not finish", done.await(10, TimeUnit.SECONDS)); }
  }

  private static final class FakeFactory implements TranslationRuntimeFactory {
    final boolean blockSecond;
    final CountDownLatch secondStarted = new CountDownLatch(1);
    final CountDownLatch cancelled = new CountDownLatch(1);
    final AtomicInteger generated = new AtomicInteger();
    final AtomicInteger opened = new AtomicInteger();
    FakeFactory(boolean blockSecond) { this.blockSecond = blockSecond; }
    public TranslationRuntime open(File model, File cache, int threads, String instruction) {
      opened.incrementAndGet();
      return new TranslationRuntime() {
        public String translate(String prompt) throws Exception {
          generated.incrementAndGet();
          JsonObject input = JsonParser.parseString(prompt).getAsJsonObject();
          String id = input.getAsJsonArray("captions").get(0).getAsJsonObject().get("id").getAsString();
          if (blockSecond && id.equals("two")) {
            secondStarted.countDown();
            cancelled.await(10, TimeUnit.SECONDS);
            throw new CancellationException("cancelled");
          }
          JsonObject caption = new JsonObject();
          caption.addProperty("id", id);
          caption.addProperty("text", "\u4f60\u597d " + id);
          JsonArray result = new JsonArray();
          result.add(caption);
          return result.toString();
        }
        public void cancel() { cancelled.countDown(); }
        public void close() { }
      };
    }
  }
}
