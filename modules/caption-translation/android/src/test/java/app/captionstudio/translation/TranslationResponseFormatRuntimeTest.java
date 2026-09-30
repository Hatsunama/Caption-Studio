package app.captionstudio.translation;

import static org.junit.Assert.*;

import java.lang.reflect.InvocationTargetException;
import org.junit.Test;

public class TranslationResponseFormatRuntimeTest {
  private static String call(TranslationRuntime runtime, String prompt, int tokens,
      boolean structured, String schema) throws Exception {
    try {
      return (String) TranslationRuntime.class.getDeclaredMethod("translate", String.class,
          int.class, boolean.class, String.class).invoke(runtime, prompt, tokens, structured, schema);
    } catch (InvocationTargetException failure) {
      if (failure.getCause() instanceof Exception) throw (Exception) failure.getCause();
      throw failure;
    }
  }

  @Test public void wrapperForwardsAllFourArgumentsAndDelegateResultUnchanged() throws Exception {
    for (TranslationBackendSelection.Preference preference : TranslationBackendSelection.Preference.values()) {
      for (boolean fallback : new boolean[] {false, true}) {
        if (fallback && preference == TranslationBackendSelection.Preference.CPU) continue;
        RecordingRuntime delegate = new RecordingRuntime();
        TranslationRuntime wrapper = TranslationBackendSelection.open(preference,
            backend -> new TranslationBackendSelection.Candidate() {
              public TranslationRuntime initialize() throws Exception {
                if (fallback && "gpu".equals(backend)) throw new Exception("Unavailable");
                return delegate;
              }
              public void close() {}
            }, () -> false);
        String schema = new String("{\"type\":\"array\"}");
        String prompt = new String("opaque prompt");
        assertSame(delegate.result, call(wrapper, prompt, 296, true, schema));
        assertSame(prompt, delegate.prompt);
        assertSame(schema, delegate.schema);
        assertEquals(296, delegate.tokens);
        assertTrue(delegate.structured);
        assertSame(delegate.result, call(wrapper, prompt, 512, false, null));
        assertNull(delegate.schema);
        assertFalse(delegate.structured);
        assertEquals(512, delegate.tokens);
        delegate.failure = new IllegalStateException("Generation failed");
        assertSame(delegate.failure, assertThrows(IllegalStateException.class,
            () -> call(wrapper, prompt, 64, true, schema)));
        wrapper.cancel(); wrapper.close();
        assertTrue(delegate.cancelled); assertTrue(delegate.closed);
      }
    }
  }

  @Test public void defaultOverloadKeepsOldThreeArgumentFakesCompatible() throws Exception {
    LegacyRuntime runtime = new LegacyRuntime();
    assertEquals("legacy", call(runtime, "opaque", 296, true, "{\"type\":\"array\"}"));
    assertEquals("opaque", runtime.prompt); assertEquals(296, runtime.tokens); assertTrue(runtime.structured);
  }

  @Test public void defaultOverloadRetainsUnsupportedStructuredOutputFailure() throws Exception {
    TranslationRuntime runtime = new TranslationRuntime() {
      public String translate(String prompt) { return prompt; }
      public void cancel() {}
      public void close() {}
    };
    assertThrows(UnsupportedOperationException.class, () -> call(runtime, "opaque", 64, true, "{}"));
    assertEquals("opaque", call(runtime, "opaque", 64, false, null));
  }

  private static class LegacyRuntime implements TranslationRuntime {
    String prompt; int tokens; boolean structured;
    public String translate(String prompt) { return "one"; }
    public String translate(String prompt, int tokens, boolean structured) {
      this.prompt = prompt; this.tokens = tokens; this.structured = structured;
      return "legacy";
    }
    public void cancel() {}
    public void close() {}
  }

  private static final class RecordingRuntime extends LegacyRuntime {
    String schema;
    final String result = new String("response");
    IllegalStateException failure;
    boolean cancelled; boolean closed;
    // Intentionally no @Override: compiles before the optional interface overload exists.
    public String translate(String prompt, int tokens, boolean structured, String schema) {
      this.prompt = prompt; this.tokens = tokens; this.structured = structured; this.schema = schema;
      if (failure != null) throw failure;
      return result;
    }
    public void cancel() { cancelled = true; }
    public void close() { closed = true; }
  }
}
