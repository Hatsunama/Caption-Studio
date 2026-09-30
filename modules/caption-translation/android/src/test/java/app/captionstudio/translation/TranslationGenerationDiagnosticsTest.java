package app.captionstudio.translation;

import static org.junit.Assert.*;

import java.lang.reflect.Method;
import java.util.Map;
import org.junit.Test;

public class TranslationGenerationDiagnosticsTest {
  @Test public void optionalApiKeepsExistingRuntimesCompatible() throws Exception {
    TranslationRuntime runtime = new TranslationRuntime() {
      public String translate(String prompt) { return ""; }
      public void cancel() {}
      public void close() {}
    };
    assertTrue(diagnostics(runtime).isEmpty());
  }

  @Test public void observedCountsAndTimingsAreReportedWithoutInventingEos() throws Exception {
    Map<String, Object> values = snapshot(benchmark(0.25, 0.5, 20, 8, 40, 16), 8, true);
    assertEquals(true, values.get("benchmarkAvailable"));
    assertEquals(20, values.get("prefillTokenCount"));
    assertEquals(8, values.get("decodeTokenCount"));
    assertEquals(250.0, values.get("initTimeMs"));
    assertEquals(500.0, values.get("timeToFirstTokenMs"));
    assertEquals(40.0, values.get("prefillTokensPerSecond"));
    assertEquals(16.0, values.get("decodeTokensPerSecond"));
    assertEquals(500.0, values.get("prefillDurationMsFromThroughput"));
    assertEquals(500.0, values.get("decodeDurationMsFromThroughput"));
    assertEquals(true, values.get("outputTokenLimitHit"));
    assertEquals("unknown", values.get("terminationReason"));
    assertThrows(UnsupportedOperationException.class, () -> values.put("prompt", "private"));
    assertEquals(false, snapshot(benchmark(0, 0, 20, 7, 40, 16), 8, true)
        .get("outputTokenLimitHit"));
  }

  @Test public void unavailableInvalidOrPartialMetricsKeepTerminationUnknown() throws Exception {
    Map<String, Object> missing = snapshot(null, 8, false);
    assertEquals(false, missing.get("benchmarkAvailable"));
    assertFalse(missing.containsKey("outputTokenLimitHit"));
    assertEquals("unknown", missing.get("terminationReason"));
    Map<String, Object> invalid = snapshot(
        benchmark(Double.NaN, -1, -1, -1, Double.POSITIVE_INFINITY, 0), 8, true);
    assertFalse(invalid.containsKey("prefillTokenCount"));
    assertFalse(invalid.containsKey("decodeTokenCount"));
    assertFalse(invalid.containsKey("initTimeMs"));
    assertFalse(invalid.containsKey("timeToFirstTokenMs"));
    assertFalse(invalid.containsKey("prefillTokensPerSecond"));
    assertFalse(invalid.containsKey("decodeDurationMsFromThroughput"));
    assertFalse(invalid.containsKey("outputTokenLimitHit"));
    assertFalse(snapshot(benchmark(0, 0, 20, 7, 40, 16), 8, false)
        .containsKey("outputTokenLimitHit"));
    assertFalse(snapshot(benchmark(0, 0, 0, 0, 0, 0), 8, true)
        .containsKey("outputTokenLimitHit"));
    assertEquals(true, snapshot(benchmark(0, 0, 20, 8, 40, 16), 8, false)
        .get("outputTokenLimitHit"));
  }

  @Test public void diagnosticStateIsSafeBeforeGenerationAndClearsPreviousSnapshot() throws Exception {
    Class<?> stateType = Class.forName("app.captionstudio.translation.TranslationGenerationDiagnosticsState");
    Object state = stateType.getConstructor().newInstance();
    Method get = stateType.getMethod("get");
    Method set = stateType.getMethod("set", Map.class);
    Method clear = stateType.getMethod("clear");
    assertEquals(Map.of(), get.invoke(state));
    Map<String, Object> previous = snapshot(benchmark(0, 0, 20, 8, 40, 16), 8, true);
    set.invoke(state, previous);
    assertSame(previous, get.invoke(state));
    clear.invoke(state);
    assertEquals(Map.of(), get.invoke(state));
    // A held snapshot remains stable after clearing the state for the next call.
    assertEquals(8, previous.get("decodeTokenCount"));
    Map<String, Object> unavailable = snapshot(null, 16, false);
    set.invoke(state, unavailable);
    assertSame(unavailable, get.invoke(state));
    assertFalse(((Map<?, ?>) get.invoke(state)).containsKey("decodeTokenCount"));
    clear.invoke(state);
    assertEquals(Map.of(), get.invoke(state));
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> diagnostics(TranslationRuntime runtime) throws Exception {
    return (Map<String, Object>) TranslationRuntime.class.getMethod("lastGenerationDiagnostics").invoke(runtime);
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> snapshot(Observation info, int limit, boolean succeeded)
      throws Exception {
    Method method = Class.forName("app.captionstudio.translation.TranslationGenerationDiagnostics")
        .getMethod("snapshot", boolean.class, double.class, double.class, int.class,
            int.class, double.class, double.class, int.class, boolean.class);
    return (Map<String, Object>) method.invoke(null, info != null,
        info == null ? 0.0 : info.init(), info == null ? 0.0 : info.first(),
        info == null ? -1 : info.prefill(), info == null ? -1 : info.decode(),
        info == null ? 0.0 : info.prefillRate(), info == null ? 0.0 : info.decodeRate(),
        limit, succeeded);
  }

  private static Observation benchmark(double init, double first, int prefill, int decode,
      double prefillRate, double decodeRate) {
    return new Observation(init, first, prefill, decode, prefillRate, decodeRate);
  }

  private record Observation(double init, double first, int prefill, int decode,
      double prefillRate, double decodeRate) {}
}
