package app.captionstudio.translation;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;

public final class TranslationBackendSelectionTest {
  private static final class EngineDouble implements TranslationBackendSelection.Candidate, TranslationRuntime {
    final String name;
    final List<String> events;
    Throwable initializationFailure;
    boolean cleanupFailure;
    Runnable afterInitialize = () -> {};
    EngineDouble(String name, List<String> events) { this.name = name; this.events = events; }
    public TranslationRuntime initialize() throws Exception {
      events.add("init-" + name);
      if (initializationFailure instanceof Exception) throw (Exception) initializationFailure;
      if (initializationFailure instanceof Error) throw (Error) initializationFailure;
      afterInitialize.run();
      return this;
    }
    public String translate(String prompt) {
      events.add("generate-" + name);
      throw new IllegalStateException("private caption in native error");
    }
    public void cancel() { events.add("cancel-" + name); }
    public void close() throws TranslationRuntimeCleanupException {
      events.add("close-" + name);
      if (cleanupFailure) throw new TranslationRuntimeCleanupException("private path", null);
    }
  }

  @Test public void preferenceIsStrictAndDefaultsToCpu() throws Exception {
    assertEquals(TranslationBackendSelection.Preference.CPU, TranslationBackendSelection.parse(null));
    for (String value : List.of("auto", "cpu", "gpu")) {
      assertEquals(value.toUpperCase(), TranslationBackendSelection.parse(value).name());
    }
    for (Object value : List.of("GPU", "", "npu", true, 3)) {
      assertEquals(NaturalCaptionTranslator.INVALID_REQUEST,
          assertThrows(NaturalCaptionTranslator.TranslationFailure.class,
              () -> TranslationBackendSelection.parse(value)).code);
    }
  }

  @Test public void cpuOverrideNeverCreatesGpu() throws Exception {
    List<String> events = new ArrayList<>();
    try (TranslationRuntime runtime = TranslationBackendSelection.open(
        TranslationBackendSelection.Preference.CPU, name -> {
          assertEquals("cpu", name); return new EngineDouble(name, events);
        }, () -> false)) {
      assertEquals("cpu", runtime.backendName());
      assertFalse(runtime.initializationFallback());
      runtime.cancel();
    }
    assertEquals(List.of("init-cpu", "cancel-cpu", "close-cpu"), events);
  }

  @Test public void autoAndGpuReportGpuAndNeverRetryGenerationOnCpu() throws Exception {
    for (var preference : List.of(TranslationBackendSelection.Preference.AUTO, TranslationBackendSelection.Preference.GPU)) {
      List<String> events = new ArrayList<>();
      try (TranslationRuntime runtime = TranslationBackendSelection.open(preference,
          name -> { assertEquals("gpu", name); return new EngineDouble(name, events); }, () -> false)) {
        assertEquals("gpu", runtime.backendName());
        assertFalse(runtime.initializationFallback());
        assertThrows(IllegalStateException.class, () -> runtime.translate("private caption", 128));
      }
      assertEquals(List.of("init-gpu", "generate-gpu", "close-gpu"), events);
    }
  }

  @Test public void gpuInitializationCleansUpBeforeCpuFallback() throws Exception {
    for (Throwable failure : List.of(new IllegalStateException("driver"), new UnsatisfiedLinkError("driver"))) {
      List<String> events = new ArrayList<>();
      try (TranslationRuntime runtime = TranslationBackendSelection.open(
          TranslationBackendSelection.Preference.AUTO, name -> {
            EngineDouble engine = new EngineDouble(name, events);
            if (name.equals("gpu")) engine.initializationFailure = failure;
            return engine;
          }, () -> false)) {
        assertEquals("cpu", runtime.backendName());
        assertTrue(runtime.initializationFallback());
      }
      assertEquals(List.of("init-gpu", "close-gpu", "init-cpu", "close-cpu"), events);
    }
  }

  @Test public void cleanupFailureBlocksFallbackAndSanitizesNativeDetails() {
    List<String> events = new ArrayList<>();
    var failure = assertThrows(TranslationRuntimeCleanupException.class,
        () -> TranslationBackendSelection.open(TranslationBackendSelection.Preference.AUTO, name -> {
          EngineDouble engine = new EngineDouble(name, events);
          engine.initializationFailure = new IllegalStateException("private caption");
          engine.cleanupFailure = true;
          return engine;
        }, () -> false));
    assertEquals(List.of("init-gpu", "close-gpu"), events);
    assertNull(failure.getCause());
    assertFalse(failure.toString().contains("private"));
  }

  @Test public void cancellationInterruptionAndFatalMemoryFailureNeverFallback() {
    for (Throwable failure : List.of(new CancellationException(), new InterruptedException(), new OutOfMemoryError())) {
      List<String> events = new ArrayList<>();
      assertThrows(failure.getClass(), () -> TranslationBackendSelection.open(
          TranslationBackendSelection.Preference.AUTO, name -> {
            EngineDouble engine = new EngineDouble(name, events);
            engine.initializationFailure = failure;
            return engine;
          }, () -> false));
      assertEquals(List.of("init-gpu", "close-gpu"), events);
    }
  }

  @Test public void cancellationAfterInitializationClosesWithoutFallback() {
    AtomicBoolean cancelled = new AtomicBoolean();
    List<String> events = new ArrayList<>();
    assertThrows(CancellationException.class, () -> TranslationBackendSelection.open(
        TranslationBackendSelection.Preference.AUTO, name -> {
          EngineDouble engine = new EngineDouble(name, events);
          engine.afterInitialize = () -> cancelled.set(true);
          return engine;
        }, cancelled::get));
    assertEquals(List.of("init-gpu", "close-gpu"), events);
  }

  @Test public void cancelledBeforeOpenAllocatesNothing() {
    assertThrows(CancellationException.class, () -> TranslationBackendSelection.open(
        TranslationBackendSelection.Preference.AUTO, name -> { throw new AssertionError(); }, () -> true));
  }

  @Test public void bothInitializationFailuresAreClosedAndTerminal() {
    List<String> events = new ArrayList<>();
    assertThrows(IllegalStateException.class, () -> TranslationBackendSelection.open(
        TranslationBackendSelection.Preference.AUTO, name -> {
          EngineDouble engine = new EngineDouble(name, events);
          engine.initializationFailure = new IllegalStateException();
          return engine;
        }, () -> false));
    assertEquals(List.of("init-gpu", "close-gpu", "init-cpu", "close-cpu"), events);
  }

  @Test public void cancellationDuringFailedInitializationPreventsCpuAllocation() {
    AtomicBoolean cancelled = new AtomicBoolean();
    List<String> events = new ArrayList<>();
    assertThrows(CancellationException.class, () -> TranslationBackendSelection.open(
        TranslationBackendSelection.Preference.AUTO, name -> new TranslationBackendSelection.Candidate() {
          public TranslationRuntime initialize() {
            events.add(name); cancelled.set(true); throw new IllegalStateException();
          }
          public void close() { events.add("closed"); }
        }, cancelled::get));
    assertEquals(List.of("gpu", "closed"), events);
  }
}
