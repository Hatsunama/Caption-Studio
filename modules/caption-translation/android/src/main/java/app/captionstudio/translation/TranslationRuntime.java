package app.captionstudio.translation;

interface TranslationRuntime extends AutoCloseable {
  default String backendName() { return "unknown"; }

  default boolean initializationFallback() { return false; }

  /** True only when the runtime implements constrained generation for the three-argument call. */
  default boolean supportsStructuredOutput() { return false; }

  String translate(String prompt) throws Exception;

  /** Per-request cap; the default keeps injected/test runtimes source compatible. */
  default String translate(String prompt, int maxOutputTokens) throws Exception {
    return translate(prompt);
  }

  default String translate(String prompt, int maxOutputTokens, boolean requireStructuredOutput)
      throws Exception {
    if (requireStructuredOutput) {
      throw new UnsupportedOperationException("Structured translation output is unavailable");
    }
    return translate(prompt, maxOutputTokens);
  }

  void cancel();

  @Override
  void close() throws TranslationRuntimeCleanupException;
}
