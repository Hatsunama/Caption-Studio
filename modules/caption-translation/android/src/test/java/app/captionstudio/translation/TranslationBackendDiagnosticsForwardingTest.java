package app.captionstudio.translation;

import static org.junit.Assert.*;

import java.util.Map;
import org.junit.Test;

public class TranslationBackendDiagnosticsForwardingTest {
  @Test public void everyBackendWrapperForwardsCurrentDiagnosticsIncludingFailedGeneration()
      throws Exception {
    for (TranslationBackendSelection.Preference preference : TranslationBackendSelection.Preference.values()) {
      for (boolean fallback : new boolean[] {false, true}) {
        if (fallback && preference != TranslationBackendSelection.Preference.AUTO) continue;
        FakeRuntime delegate = new FakeRuntime();
        TranslationRuntime wrapper = TranslationBackendSelection.open(preference,
            backend -> new TranslationBackendSelection.Candidate() {
              public TranslationRuntime initialize() throws Exception {
                if (fallback && backend.equals("gpu")) throw new Exception("Unavailable backend");
                return delegate;
              }
              public void close() {}
            }, () -> false);
        assertEquals(fallback, wrapper.initializationFallback());
        assertEquals(preference == TranslationBackendSelection.Preference.CPU || fallback ? "cpu" : "gpu",
            wrapper.backendName());
        assertTrue(wrapper.supportsStructuredOutput());
        assertTrue(wrapper.lastGenerationDiagnostics().isEmpty());
        wrapper.translate("private");
        assertEquals(Map.of("decodeTokenCount", 32), wrapper.lastGenerationDiagnostics());
        assertSame(delegate.values, wrapper.lastGenerationDiagnostics());
        wrapper.translate("private", 64);
        assertEquals(Map.of("decodeTokenCount", 64), wrapper.lastGenerationDiagnostics());
        wrapper.translate("private", 128, true);
        assertTrue(delegate.structured);
        assertEquals(Map.of("decodeTokenCount", 128), wrapper.lastGenerationDiagnostics());
        delegate.fail = true;
        assertThrows(Exception.class, () -> wrapper.translate("private", 16, true));
        assertEquals(Map.of("decodeTokenCount", 16), wrapper.lastGenerationDiagnostics());
        wrapper.cancel();
        assertTrue(delegate.cancelled);
        wrapper.close();
        assertTrue(delegate.closed);
        assertTrue(wrapper.lastGenerationDiagnostics().isEmpty());
      }
    }
  }

  private static final class FakeRuntime implements TranslationRuntime {
    Map<String, Object> values = Map.of();
    boolean fail;
    boolean structured;
    boolean cancelled;
    boolean closed;
    public boolean supportsStructuredOutput() { return true; }
    public Map<String, Object> lastGenerationDiagnostics() { return values; }
    public String translate(String prompt) throws Exception { return translate(prompt, 32, false); }
    public String translate(String prompt, int limit) throws Exception { return translate(prompt, limit, false); }
    public String translate(String prompt, int limit, boolean requireStructuredOutput) throws Exception {
      structured = requireStructuredOutput;
      values = Map.of("decodeTokenCount", limit);
      if (fail) throw new Exception("Generation failed");
      return "";
    }
    public void cancel() { cancelled = true; }
    public void close() { closed = true; values = Map.of(); }
  }
}
