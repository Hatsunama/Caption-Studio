package app.captionstudio.translation;

import static org.junit.Assert.*;

import java.io.File;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

/** Exercises real execute/finish paths with native work that does not obey stop immediately. */
public final class TranslationCancellationFailureTest {
  @Test public void successfulNativeReturnAfterCancelIsCancelledAndRetryWorks() throws Exception {
    try (Harness h = new Harness(null, null, null, false, false)) {
      h.startAndAwaitNative();
      h.translator.cancel();
      h.assertBusyAndUndelivered();
      h.releaseAndAwait();
      h.assertTerminal(NaturalCaptionTranslator.CANCELLED, "cancelled");
      h.assertRetryWorks();
      assertEquals(1, h.runtime.stops.get());
    }
  }

  @Test public void actualCancellationExceptionRemainsCancelled() throws Exception {
    assertConcurrentFailure(new CancellationException("native stop"), NaturalCaptionTranslator.CANCELLED);
  }

  @Test public void actualInterruptedExceptionRemainsCancelled() throws Exception {
    assertConcurrentFailure(new InterruptedException("native interrupted"), NaturalCaptionTranslator.CANCELLED);
  }

  @Test public void inferenceFailureWinsConcurrentCancel() throws Exception {
    assertConcurrentFailure(new IllegalStateException("private inference detail"), NaturalCaptionTranslator.FAILED);
  }

  @Test public void storageFailureWinsConcurrentCancel() throws Exception {
    try (Harness h = new Harness(new NaturalCaptionTranslator.TranslationFailure(
        NaturalCaptionTranslator.FAILED, "Translation progress could not be saved or restored."),
        null, null, false, false)) {
      h.startAndAwaitNative();
      h.translator.cancel();
      h.assertBusyAndUndelivered();
      h.releaseAndAwait();
      h.assertTerminal(NaturalCaptionTranslator.FAILED, "failed");
      assertEquals("Translation progress could not be saved or restored.", h.callback.message.get());
      h.assertRetryWorks();
    }
  }

  @Test public void loadingFailureWinsConcurrentCancelAndOwnerStaysBusy() throws Exception {
    try (Harness h = new Harness(new IllegalStateException("private loading detail"),
        null, null, true, false)) {
      h.startAndAwaitNative();
      h.translator.cancel();
      h.assertBusyAndUndelivered();
      h.releaseAndAwait();
      h.assertTerminal(NaturalCaptionTranslator.FAILED, "failed");
      assertEquals(0, h.runtime.closes.get());
      h.assertRetryWorks();
    }
  }

  @Test public void outOfMemoryWinsConcurrentCancel() throws Exception {
    assertConcurrentFailure(new OutOfMemoryError("private allocation detail"), NaturalCaptionTranslator.FAILED);
  }

  @Test public void linkageFailureWinsConcurrentCancel() throws Exception {
    assertConcurrentFailure(new UnsatisfiedLinkError("private library detail"), NaturalCaptionTranslator.UNSUPPORTED);
  }

  @Test public void genuineFailureWinsThreadInterruptWithoutCancelRequest() throws Exception {
    try (Harness h = new Harness(new IllegalStateException("private inference detail"),
        null, null, false, true)) {
      h.startAndAwaitNative();
      h.releaseAndAwait();
      h.assertTerminal(NaturalCaptionTranslator.FAILED, "failed");
      h.assertRetryWorks();
    }
  }

  @Test public void cancellationDuringCleanupCannotReplaceAlreadyCaughtFailure() throws Exception {
    try (Harness h = new Harness(new IllegalStateException("private inference detail"),
        null, null, false, false)) {
      h.runtime.blockClose = true;
      h.startAndAwaitNative();
      h.runtime.release.countDown();
      await(h.runtime.closeEntered);
      h.translator.cancel();
      h.assertBusyAndUndelivered();
      h.runtime.closeRelease.countDown();
      h.awaitCompletion();
      h.assertTerminal(NaturalCaptionTranslator.FAILED, "failed");
      h.assertRetryWorks();
    }
  }

  @Test public void stopSignalFailureWinsCancellationAndIsDeliveredOnceAfterExit() throws Exception {
    try (Harness h = new Harness(null, new IllegalStateException("private stop detail"),
        null, false, false)) {
      h.startAndAwaitNative();
      // Always unblock work even if the baseline android.jar Log.w stub throws.
      Throwable cancelThrown = null;
      try { h.translator.cancel(); } catch (Throwable caught) { cancelThrown = caught; }
      h.assertBusyAndUndelivered();
      h.releaseAndAwait();
      h.assertTerminal(NaturalCaptionTranslator.FAILED, "failed");
      assertNotNull(h.callback.cause.get());
      assertFalse(h.callback.cause.get().toString().contains("private stop detail"));
      assertNull("cancel must record stop failure without throwing", cancelThrown);
      assertEquals(1, h.runtime.stops.get());
      h.translator.cancel();
      assertEquals(1, h.callback.deliveries.get());
      h.assertRetryWorks();
    }
  }

  @Test public void cleanupFailureWinsInferenceAndCancelPoisonsReuse() throws Exception {
    assertCleanupWins(new IllegalStateException("private inference detail"),
        new IllegalStateException("private stop detail"));
  }

  @Test public void cleanupFailureWinsActualCancellationAndPoisonsReuse() throws Exception {
    assertCleanupWins(new CancellationException("native stop"), null);
  }

  private static void assertConcurrentFailure(Throwable failure, String code) throws Exception {
    try (Harness h = new Harness(failure, null, null, false, false)) {
      h.startAndAwaitNative();
      h.translator.cancel();
      h.assertBusyAndUndelivered();
      h.releaseAndAwait();
      h.assertTerminal(code, NaturalCaptionTranslator.CANCELLED.equals(code) ? "cancelled" : "failed");
      h.assertRetryWorks();
    }
  }

  private static void assertCleanupWins(Throwable failure, RuntimeException stop) throws Exception {
    try (Harness h = new Harness(failure, stop,
        new TranslationRuntimeCleanupException("private cleanup detail", null), false, false)) {
      h.startAndAwaitNative();
      try { h.translator.cancel(); } catch (RuntimeException androidLogStub) {
        // The terminal assertion still runs; harness errors are reported separately by stopSignalFailure.
      }
      h.assertBusyAndUndelivered();
      h.releaseAndAwait();
      h.assertTerminal(NaturalCaptionTranslator.FAILED, "failed");
      assertTrue(h.callback.message.get().contains("could not release its resources safely"));
      assertFalse(h.callback.cause.get().toString().contains("private cleanup detail"));
      Recording next = new Recording();
      h.translator.start(h.model.getAbsolutePath(), request(), next);
      await(next.done);
      assertEquals(NaturalCaptionTranslator.RELEASED, next.code.get());
      assertEquals(1, next.deliveries.get());
      assertEquals(1, h.opens.get());
    }
  }

  private static Map<String, Object> request() {
    return Map.of("operations", List.of(Map.of(
        "id", "operation", "sourceLanguage", "en", "targetLanguage", "es",
        "batches", List.of(Map.of("captions", List.of(Map.of("id", "one", "text", "Hello friend.")))))));
  }

  private static void await(CountDownLatch latch) throws InterruptedException {
    assertTrue("barrier timed out", latch.await(5, TimeUnit.SECONDS));
  }

  private static void throwFailure(Throwable failure) throws Exception {
    if (failure instanceof Error) throw (Error) failure;
    if (failure instanceof Exception) throw (Exception) failure;
  }

  private static final class Harness implements AutoCloseable {
    final File model;
    final ExecutorService worker = Executors.newSingleThreadExecutor();
    final AtomicInteger opens = new AtomicInteger();
    final BarrierRuntime runtime;
    final Recording callback = new Recording();
    final NaturalCaptionTranslator translator;
    final boolean loading;

    Harness(Throwable failure, RuntimeException stopFailure,
        TranslationRuntimeCleanupException cleanupFailure, boolean loading, boolean interrupt)
        throws Exception {
      this.loading = loading;
      model = Files.createTempFile("translation-cancel-cause", ".litertlm").toFile();
      Files.write(model.toPath(), new byte[] {1});
      runtime = new BarrierRuntime(failure, stopFailure, cleanupFailure, interrupt);
      TranslationEnvironment environment = new TranslationEnvironment() {
        @Override public File prepareCacheDirectory() { return model.getParentFile(); }
        @Override public void verifyDeviceCapacity(File selected) { }
      };
      TranslationRuntimeFactory factory = (selected, cache, threads, instruction) -> {
        if (opens.incrementAndGet() > 1) return new BarrierRuntime(null, null, null, false, false);
        if (loading) {
          runtime.entered.countDown();
          await(runtime.release);
          throwFailure(failure);
        }
        return runtime;
      };
      translator = new NaturalCaptionTranslator(environment, factory,
          (selected, cancelled, progress) -> progress.accept(100), worker, line -> {});
    }

    void startAndAwaitNative() throws Exception {
      translator.start(model.getAbsolutePath(), request(), callback);
      await(runtime.entered);
    }

    void assertBusyAndUndelivered() throws Exception {
      assertEquals("terminal delivery must wait for native exit", 0, callback.deliveries.get());
      assertEquals("close must wait for translate exit", runtime.blockClose ? 1 : 0, runtime.closes.get());
      Recording busy = new Recording();
      translator.start(model.getAbsolutePath(), request(), busy);
      await(busy.done);
      assertEquals(NaturalCaptionTranslator.BUSY, busy.code.get());
      assertEquals(1, busy.deliveries.get());
      assertEquals(1, opens.get());
    }

    void releaseAndAwait() throws Exception {
      runtime.release.countDown();
      awaitCompletion();
    }

    void awaitCompletion() throws Exception {
      await(callback.done);
      // Drain the worker so exactly-once assertions do not race a late second delivery.
      worker.submit(() -> {}).get(5, TimeUnit.SECONDS);
    }

    void assertTerminal(String code, String stage) {
      assertEquals(code, callback.code.get());
      assertNull(callback.result.get());
      assertEquals(1, callback.deliveries.get());
      assertEquals(stage, translator.getProgress().get("stage"));
      assertEquals(loading ? 0 : 1, runtime.closes.get());
    }

    void assertRetryWorks() throws Exception {
      Recording retry = new Recording();
      translator.start(model.getAbsolutePath(), request(), retry);
      await(retry.done);
      worker.submit(() -> {}).get(5, TimeUnit.SECONDS);
      assertNull(retry.code.get());
      assertNotNull(retry.result.get());
      assertEquals(1, retry.deliveries.get());
      assertEquals(2, opens.get());
      assertEquals(1, callback.deliveries.get());
    }

    @Override public void close() throws Exception {
      runtime.release.countDown();
      runtime.closeRelease.countDown();
      translator.close();
      worker.shutdownNow();
      assertTrue(worker.awaitTermination(5, TimeUnit.SECONDS));
      Files.deleteIfExists(model.toPath());
    }
  }

  private static final class Recording implements NaturalCaptionTranslator.Callback {
    final CountDownLatch done = new CountDownLatch(1);
    final AtomicInteger deliveries = new AtomicInteger();
    final AtomicReference<String> code = new AtomicReference<>();
    final AtomicReference<String> message = new AtomicReference<>();
    final AtomicReference<Throwable> cause = new AtomicReference<>();
    final AtomicReference<Map<String, Object>> result = new AtomicReference<>();
    @Override public void onSuccess(Map<String, Object> value) {
      result.set(value); deliveries.incrementAndGet(); done.countDown();
    }
    @Override public void onError(String value, String text, Throwable error) {
      code.set(value); message.set(text); cause.set(error); deliveries.incrementAndGet(); done.countDown();
    }
  }

  private static final class BarrierRuntime implements TranslationRuntime {
    final CountDownLatch entered = new CountDownLatch(1);
    final CountDownLatch release = new CountDownLatch(1);
    final CountDownLatch closeEntered = new CountDownLatch(1);
    final CountDownLatch closeRelease = new CountDownLatch(1);
    final AtomicInteger stops = new AtomicInteger();
    final AtomicInteger closes = new AtomicInteger();
    final Throwable failure;
    final RuntimeException stopFailure;
    final TranslationRuntimeCleanupException cleanupFailure;
    final boolean interrupt;
    final boolean block;
    volatile boolean blockClose;

    BarrierRuntime(Throwable failure, RuntimeException stopFailure,
        TranslationRuntimeCleanupException cleanupFailure, boolean interrupt) {
      this(failure, stopFailure, cleanupFailure, interrupt, true);
    }
    BarrierRuntime(Throwable failure, RuntimeException stopFailure,
        TranslationRuntimeCleanupException cleanupFailure, boolean interrupt, boolean block) {
      this.failure = failure; this.stopFailure = stopFailure;
      this.cleanupFailure = cleanupFailure; this.interrupt = interrupt; this.block = block;
    }
    @Override public String translate(String prompt) throws Exception {
      entered.countDown();
      if (block) await(release);
      if (interrupt) Thread.currentThread().interrupt();
      throwFailure(failure);
      return "[{\"id\":\"one\",\"text\":\"Hola amigo.\"}]";
    }
    @Override public void cancel() {
      stops.incrementAndGet();
      if (stopFailure != null) throw stopFailure;
    }
    @Override public void close() throws TranslationRuntimeCleanupException {
      closes.incrementAndGet();
      closeEntered.countDown();
      if (blockClose) {
        try { await(closeRelease); } catch (InterruptedException error) {
          Thread.currentThread().interrupt();
          throw new TranslationRuntimeCleanupException("cleanup interrupted", error);
        }
      }
      if (cleanupFailure != null) throw cleanupFailure;
    }
  }
}
