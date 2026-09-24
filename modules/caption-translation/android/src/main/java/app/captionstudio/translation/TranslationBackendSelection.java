package app.captionstudio.translation;

import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;

/** Owns initialization only. A returned runtime never changes backend during generation. */
final class TranslationBackendSelection {
  enum Preference { AUTO, CPU, GPU }

  interface Candidate {
    TranslationRuntime initialize() throws Exception;
    void close() throws Exception;
  }

  interface Factory {
    Candidate create(String backend) throws Exception;
  }

  static Preference parse(Object value) throws NaturalCaptionTranslator.TranslationFailure {
    if (value == null) return Preference.CPU;
    if ("auto".equals(value)) return Preference.AUTO;
    if ("cpu".equals(value)) return Preference.CPU;
    if ("gpu".equals(value)) return Preference.GPU;
    throw new NaturalCaptionTranslator.TranslationFailure(
        NaturalCaptionTranslator.INVALID_REQUEST, "runtimeBackend must be auto, cpu, or gpu.");
  }

  static TranslationRuntime open(Preference preference, Factory factory, BooleanSupplier cancelled)
      throws Exception {
    if (preference == Preference.CPU) return attempt("cpu", false, factory, cancelled);
    try {
      return attempt("gpu", false, factory, cancelled);
    } catch (Exception | LinkageError failure) {
      if (failure instanceof TranslationRuntimeCleanupException
          || failure instanceof CancellationException || failure instanceof InterruptedException) {
        throw failure;
      }
      checkCancelled(cancelled);
      return attempt("cpu", true, factory, cancelled);
    }
  }

  private static TranslationRuntime attempt(
      String backend, boolean fallback, Factory factory, BooleanSupplier cancelled) throws Exception {
    checkCancelled(cancelled);
    Candidate candidate = factory.create(backend);
    TranslationRuntime runtime;
    try {
      runtime = candidate.initialize();
      checkCancelled(cancelled);
    } catch (Throwable failure) {
      try {
        candidate.close();
      } catch (Throwable cleanup) {
        // Deliberately omit native messages: they can include paths or model data.
        throw new TranslationRuntimeCleanupException("Backend initialization cleanup failed", null);
      }
      if (failure instanceof Exception) throw (Exception) failure;
      if (failure instanceof Error) throw (Error) failure;
      throw new IllegalStateException("Backend initialization failed");
    }
    return new TranslationRuntime() {
      public String backendName() { return backend; }
      public boolean initializationFallback() { return fallback; }
      public boolean supportsStructuredOutput() { return runtime.supportsStructuredOutput(); }
      public String translate(String prompt) throws Exception { return runtime.translate(prompt); }
      public String translate(String prompt, int tokens) throws Exception {
        return runtime.translate(prompt, tokens);
      }
      public String translate(String prompt, int tokens, boolean requireStructuredOutput) throws Exception {
        return runtime.translate(prompt, tokens, requireStructuredOutput);
      }
      public void cancel() { runtime.cancel(); }
      public void close() throws TranslationRuntimeCleanupException { runtime.close(); }
    };
  }

  private static void checkCancelled(BooleanSupplier cancelled) {
    if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) {
      throw new CancellationException("Caption translation was cancelled");
    }
  }

  private TranslationBackendSelection() {}
}
