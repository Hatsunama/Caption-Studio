package app.captionstudio.translation;

import static org.junit.Assert.*;
import com.google.ai.edge.litertlm.*;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.concurrent.locks.ReentrantLock;
import org.junit.Test;

/** Executes the production adapter, using only the engine/conversation boundary as a fake. */
public class TranslationSdkCancellationAdapterTest {
  static final String SCHEMA = "{\"type\":\"array\"}";
  static ConversationConfig config() {
    return new ConversationConfig(Contents.Companion.of("SYSTEM"), Collections.emptyList(),
        Collections.emptyList(), new SamplerConfig(1, 1.0, 0.0, 0), false,
        Collections.emptyList(), Collections.emptyMap(), null, false, 1536,
        new ThinkingConfig(false, -1), false);
  }

  static final class Fixture implements AutoCloseable {
    final ExecutorService worker = Executors.newSingleThreadExecutor();
    final CountDownLatch entered = new CountDownLatch(1);
    final AtomicInteger closes = new AtomicInteger(), engineCloses = new AtomicInteger();
    final AtomicInteger cancels = new AtomicInteger(), creations = new AtomicInteger();
    volatile MessageCallback callback;
    volatile String prompt;
    volatile int tokens;
    volatile ResponseFormat format;
    volatile ConversationConfig createdConfig;
    volatile Throwable dispatchFailure, cancelFailure, cleanupFailure;
    volatile CountDownLatch dispatchGate, cancelGate;
    final CountDownLatch cancelEntered = new CountDownLatch(1);
    volatile Runnable duringDispatch;
    volatile Thread dispatchThread;
    final TranslationRuntime runtime;
    Fixture() throws Exception {
      Class<?> gatewayType = Class.forName("app.captionstudio.translation.TranslationSdkGateway");
      Class<?> sessionType = Class.forName("app.captionstudio.translation.TranslationSdkGateway$Session");
      Object session = Proxy.newProxyInstance(sessionType.getClassLoader(), new Class<?>[]{sessionType},
          (proxy, method, args) -> {
            switch (method.getName()) {
              case "sendMessageAsync":
                prompt = (String) args[0]; callback = (MessageCallback) args[1];
                tokens = (Integer) args[2]; format = (ResponseFormat) args[3];
                dispatchThread = Thread.currentThread();
                entered.countDown();
                if (duringDispatch != null) duringDispatch.run();
                if (dispatchGate != null) assertTrue(dispatchGate.await(5, TimeUnit.SECONDS));
                if (dispatchFailure != null) throw dispatchFailure;
                return null;
              case "cancelProcess":
                assertEquals(0, closes.get());
                cancels.incrementAndGet();
                cancelEntered.countDown();
                if (cancelGate != null) assertTrue(cancelGate.await(5, TimeUnit.SECONDS));
                if (cancelFailure != null) throw cancelFailure;
                return null;
              case "getBenchmarkInfo": return null;
              case "close":
                closes.incrementAndGet();
                if (cleanupFailure != null) throw cleanupFailure;
                return null;
              default: throw new AssertionError(method);
            }
          });
      Object gateway = Proxy.newProxyInstance(gatewayType.getClassLoader(), new Class<?>[]{gatewayType},
          (proxy, method, args) -> {
            switch (method.getName()) {
              case "createConversation":
                creations.incrementAndGet(); createdConfig = (ConversationConfig) args[0]; return session;
              case "isInitialized": return true;
              case "close": engineCloses.incrementAndGet(); return null;
              default: throw new AssertionError(method);
            }
          });
      Constructor<?> constructor = Class.forName("app.captionstudio.translation.LiteRtLmTranslationRuntime")
          .getDeclaredConstructor(gatewayType, ConversationConfig.class);
      constructor.setAccessible(true);
      runtime = (TranslationRuntime) constructor.newInstance(gateway, config());
    }
    Future<String> start() {
      return worker.submit(() -> runtime.translate("PROMPT", 296, true, SCHEMA));
    }
    void entered() throws Exception {
      assertTrue(entered.await(5, TimeUnit.SECONDS));
      if (dispatchGate == null) {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (dispatchThread.getState() != Thread.State.TIMED_WAITING && System.nanoTime() < until)
          Thread.yield();
        assertEquals(Thread.State.TIMED_WAITING, dispatchThread.getState());
      }
    }
    void chunk(String text) { callback.onMessage(Message.Companion.model(text)); }
    Throwable failure(Future<?> future) throws Exception {
      try { future.get(5, TimeUnit.SECONDS); fail("Expected failure"); return null; }
      catch (ExecutionException error) { return error.getCause(); }
    }
    void stillOwned(Future<?> future) throws Exception {
      assertThrows(TimeoutException.class, () -> future.get(100, TimeUnit.MILLISECONDS));
      assertEquals(0, closes.get()); assertEquals(0, engineCloses.get());
    }
    public void close() throws Exception {
      // Test cleanup releases a deliberately held fake native operation before joining the worker.
      if (dispatchGate != null) dispatchGate.countDown();
      if (cancelGate != null) cancelGate.countDown();
      if (callback != null) callback.onDone();
      worker.shutdown();
      assertTrue(worker.awaitTermination(5, TimeUnit.SECONDS));
      runtime.close();
      assertEquals(1, engineCloses.get());
    }
  }

  @Test public void successUsesRawOrderedChunksSchemaTokenConfigAndCallingWorker() throws Exception {
    try (Fixture f = new Fixture()) {
      Future<String> first = f.start(); f.entered();
      f.chunk("["); f.chunk("{\"id\":\"a\","); f.chunk("\"text\":\"ok\"}]");
      f.stillOwned(first); f.callback.onDone();
      assertEquals("[{\"id\":\"a\",\"text\":\"ok\"}]", first.get(5, TimeUnit.SECONDS));
      assertEquals("PROMPT", f.prompt); assertEquals(296, f.tokens);
      assertEquals(ResponseFormat.Type.JSON_OBJECT, f.format.getType());
      assertEquals(SCHEMA, f.format.getSchemaOrPattern());
      assertEquals(Integer.valueOf(296), f.createdConfig.getMaxOutputToken());
      assertTrue(f.createdConfig.getEnableResponseFormat());
      assertEquals("SYSTEM", f.createdConfig.getSystemInstruction().toString());
      assertEquals(1, f.closes.get());
      assertSame(f.dispatchThread, f.worker.submit(Thread::currentThread).get(5, TimeUnit.SECONDS));
      assertEquals(296, f.runtime.lastGenerationDiagnostics().get("outputTokenLimit"));
      assertEquals(false, f.runtime.lastGenerationDiagnostics().get("benchmarkAvailable"));
      MessageCallback old = f.callback;
      Future<String> second = f.worker.submit(() -> f.runtime.translate("NEXT", 512, false, null));
      long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
      while ((f.creations.get() < 2 || f.callback == old) && System.nanoTime() < until) Thread.yield();
      assertEquals(2, f.creations.get()); assertNotSame(old, f.callback);
      old.onMessage(Message.Companion.model("late")); old.onError(new IllegalStateException("late"));
      f.chunk("next"); f.callback.onDone();
      assertEquals("next", second.get(5, TimeUnit.SECONDS));
      assertNull(f.format); assertEquals(512, f.tokens); assertEquals(2, f.closes.get());
      assertFalse(f.createdConfig.getEnableResponseFormat());
    }
  }

  /** Calls the actual pinned SDK implementation; no native handle method is called. */
  static void sdkError(MessageCallback callback, int status) throws Exception {
    Conversation conversation = new Conversation(0L, new ToolManager(), false, true);
    Class<?> type = Class.forName("com.google.ai.edge.litertlm.Conversation$JniMessageCallbackImpl");
    Constructor<?> ctor = Arrays.stream(type.getDeclaredConstructors())
        .filter(c -> c.getParameterCount() == 7).findFirst().orElseThrow();
    ctor.setAccessible(true);
    Object jniCallback = ctor.newInstance(conversation, callback, null, null, null, null, null);
    Method method = type.getDeclaredMethod("onError", int.class, String.class);
    method.setAccessible(true); method.invoke(jniCallback, status, "opaque failure");
  }

  @Test public void actualPinnedSdkMapsOnlyStatusOneToCancellationWithoutNativeCalls() throws Exception {
    AtomicReference<Throwable> error = new AtomicReference<>();
    MessageCallback callback = new MessageCallback() {
      public void onMessage(Message m) { fail(); }
      public void onDone() { fail("SDK error must not require onDone"); }
      public void onError(Throwable t) { error.set(t); }
    };
    sdkError(callback, 1); assertTrue(error.get() instanceof CancellationException);
    sdkError(callback, 13); assertEquals("LiteRtLmJniException", error.get().getClass().getSimpleName());
  }

  @Test public void actualSdkTypedCancellationIsTerminalWithoutDone() throws Exception {
    try (Fixture f = new Fixture()) {
      Future<String> work = f.start(); f.entered(); f.runtime.cancel();
      sdkError(f.callback, 1);
      assertTrue(f.failure(work) instanceof CancellationException); assertEquals(1, f.closes.get());
    }
  }

  @Test public void generationFailureSurvivesConcurrentCancelAndLateCallbacks() throws Exception {
    try (Fixture f = new Fixture()) {
      Future<String> work = f.start(); f.entered(); f.runtime.cancel();
      IllegalStateException actual = new IllegalStateException("cancel JNI generation failure");
      f.callback.onError(actual); f.callback.onDone();
      f.chunk("late"); f.callback.onError(new CancellationException());
      assertSame(actual, f.failure(work)); assertEquals(1, f.closes.get());
    }
  }

  @Test public void otherActualSdkStatusSurvivesStopRequest() throws Exception {
    try (Fixture f = new Fixture()) {
      Future<String> work = f.start(); f.entered(); f.runtime.cancel(); sdkError(f.callback, 13);
      assertEquals("LiteRtLmJniException", f.failure(work).getClass().getSimpleName());
    }
  }

  @Test public void cancellationAfterTerminalDoesNotReplaceSuccessfulNativeResult() throws Exception {
    try (Fixture f = new Fixture()) {
      Future<String> work = f.start(); f.entered(); f.chunk("complete");
      f.callback.onDone(); f.runtime.cancel();
      assertEquals("complete", work.get(5, TimeUnit.SECONDS)); assertEquals(0, f.cancels.get());
    }
  }

  @Test public void startupDispatchExceptionPreservesIdentityWithoutTypedStatus() throws Exception {
    try (Fixture f = new Fixture()) {
      Throwable actual = new UnsatisfiedLinkError("cancel native startup unavailable");
      f.dispatchFailure = actual;
      Future<String> work = f.start();
      assertSame(actual, f.failure(work)); assertEquals(1, f.closes.get());
    }
  }

  @Test public void doneInsideDispatchCannotCloseBeforeDispatchReturns() throws Exception {
    try (Fixture f = new Fixture()) {
      f.dispatchGate = new CountDownLatch(1);
      f.duringDispatch = () -> { f.chunk("ok"); f.callback.onDone(); };
      Future<String> work = f.start(); f.entered(); f.stillOwned(work);
      f.dispatchGate.countDown();
      assertEquals("ok", work.get(5, TimeUnit.SECONDS)); assertEquals(1, f.closes.get());
    }
  }

  @Test public void deferredCancelAfterTryLockContentionReachesNativeBeforeTerminal() throws Exception {
    try (Fixture f = new Fixture()) {
      Future<String> work = f.start(); f.entered();
      Field field = f.runtime.getClass().getDeclaredField("lifecycleLock"); field.setAccessible(true);
      ReentrantLock lock = (ReentrantLock) field.get(f.runtime);
      ExecutorService caller = Executors.newSingleThreadExecutor();
      try {
        lock.lock();
        try { caller.submit(() -> f.runtime.cancel()).get(5, TimeUnit.SECONDS); }
        finally { lock.unlock(); }
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (f.cancels.get() == 0 && System.nanoTime() < until) Thread.yield();
        assertEquals(1, f.cancels.get()); f.stillOwned(work);
        sdkError(f.callback, 1); assertTrue(f.failure(work) instanceof CancellationException);
      } finally { caller.shutdown(); assertTrue(caller.awaitTermination(5, TimeUnit.SECONDS)); }
    }
  }

  @Test public void cancelDuringDispatchIsDeferredUntilDispatchReturns() throws Exception {
    try (Fixture f = new Fixture()) {
      f.dispatchGate = new CountDownLatch(1);
      Future<String> work = f.start(); f.entered(); f.runtime.cancel();
      assertEquals(0, f.cancels.get()); f.stillOwned(work); f.dispatchGate.countDown();
      long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
      while (f.cancels.get() == 0 && System.nanoTime() < until) Thread.yield();
      assertEquals(1, f.cancels.get()); sdkError(f.callback, 1);
      assertTrue(f.failure(work) instanceof CancellationException);
    }
  }

  @Test public void boundedBufferFailureWaitsForNativeTerminalAndDoesNotKeepGrowing() throws Exception {
    try (Fixture f = new Fixture()) {
      Future<String> work = f.start(); f.entered();
      f.chunk("x".repeat(1_048_577)); f.chunk("ignored");
      f.stillOwned(work); f.callback.onDone();
      assertTrue(f.failure(work) instanceof IllegalStateException); assertEquals(1, f.closes.get());
    }
  }

  @Test public void signalFailureDoesNotReleaseOwnerAndSurvivesTypedCancellation() throws Exception {
    try (Fixture f = new Fixture()) {
      Future<String> work = f.start(); f.entered();
      IllegalStateException signal = new IllegalStateException("native cancel dispatch failed");
      f.cancelFailure = signal;
      assertSame(signal, assertThrows(IllegalStateException.class, () -> f.runtime.cancel()));
      f.stillOwned(work); sdkError(f.callback, 1);
      assertSame(signal, f.failure(work)); assertEquals(1, f.cancels.get());
    }
  }

  @Test public void terminalDuringFailedStopSignalWaitsForSignalReturnAndKeepsFailure() throws Exception {
    try (Fixture f = new Fixture()) {
      Future<String> work = f.start(); f.entered();
      f.cancelGate = new CountDownLatch(1);
      f.cancelFailure = new IllegalStateException("stop signal failed after callback");
      ExecutorService caller = Executors.newSingleThreadExecutor();
      try {
        Future<?> stopping = caller.submit(() -> { f.runtime.cancel(); return null; });
        assertTrue(f.cancelEntered.await(5, TimeUnit.SECONDS));
        sdkError(f.callback, 1); f.stillOwned(work);
        f.cancelGate.countDown();
        assertSame(f.cancelFailure, f.failure(stopping));
        assertSame(f.cancelFailure, f.failure(work));
      } finally {
        f.cancelGate.countDown(); caller.shutdown();
        assertTrue(caller.awaitTermination(5, TimeUnit.SECONDS));
      }
    }
  }

  @Test public void generationFailureRemainsPrimaryWhenCancelSignalAlsoFails() throws Exception {
    try (Fixture f = new Fixture()) {
      Future<String> work = f.start(); f.entered();
      f.cancelFailure = new IllegalStateException("signal failed");
      assertThrows(IllegalStateException.class, () -> f.runtime.cancel());
      IllegalStateException actual = new IllegalStateException("generation failed");
      f.callback.onError(actual); assertSame(actual, f.failure(work));
      assertTrue(Arrays.asList(actual.getSuppressed()).contains(f.cancelFailure));
    }
  }

  @Test public void closeWaitsForTerminalBeforeConversationOrEngineCleanup() throws Exception {
    try (Fixture f = new Fixture()) {
      Future<String> work = f.start(); f.entered();
      ExecutorService closer = Executors.newSingleThreadExecutor();
      try {
        Future<?> closing = closer.submit(() -> { f.runtime.close(); return null; });
        assertThrows(TimeoutException.class, () -> closing.get(100, TimeUnit.MILLISECONDS));
        f.stillOwned(work); f.callback.onDone();
        work.get(5, TimeUnit.SECONDS); closing.get(5, TimeUnit.SECONDS);
        assertEquals(1, f.closes.get()); assertEquals(1, f.engineCloses.get());
      } finally { closer.shutdown(); assertTrue(closer.awaitTermination(5, TimeUnit.SECONDS)); }
    }
  }

  @Test public void cleanupFailureKeepsTypedCancellationAsSuppressedEvidence() throws Exception {
    Fixture f = new Fixture();
    try {
      f.cleanupFailure = new IllegalStateException("cleanup failed");
      Future<String> work = f.start(); f.entered(); sdkError(f.callback, 1);
      Throwable failure = f.failure(work);
      assertTrue(failure instanceof TranslationRuntimeCleanupException);
      assertSame(f.cleanupFailure, failure.getCause());
      assertTrue(Arrays.stream(failure.getCause().getSuppressed()).anyMatch(
          t -> t instanceof CancellationException));
    } finally { f.cleanupFailure = null; f.close(); }
  }
}
