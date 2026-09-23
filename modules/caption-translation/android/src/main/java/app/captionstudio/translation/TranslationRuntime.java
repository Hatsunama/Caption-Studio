package app.captionstudio.translation;

interface TranslationRuntime extends AutoCloseable {
  default String backendName() { return "unknown"; }

  default boolean initializationFallback() { return false; }

  String translate(String prompt) throws Exception;

  /** Per-request cap; the default keeps injected/test runtimes source compatible. */
  default String translate(String prompt, int maxOutputTokens) throws Exception {
    return translate(prompt);
  }

  void cancel();

  @Override
  void close() throws TranslationRuntimeCleanupException;
}
