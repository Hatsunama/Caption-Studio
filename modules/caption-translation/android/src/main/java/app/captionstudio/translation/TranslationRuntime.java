package app.captionstudio.translation;

import java.util.Collections;
import java.util.Map;

interface TranslationRuntime extends AutoCloseable {
  default String backendName() { return "unknown"; }

  default boolean initializationFallback() { return false; }

  /** True only when the runtime implements constrained generation for structured calls. */
  default boolean supportsStructuredOutput() { return false; }

  /** Optional content-free snapshot; missing metrics and termination evidence remain unknown. */
  default Map<String, Object> lastGenerationDiagnostics() { return Collections.emptyMap(); }

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

  /** Optional request schema; the default preserves existing injected/test runtimes. */
  default String translate(String prompt, int maxOutputTokens, boolean requireStructuredOutput,
      String responseSchema) throws Exception {
    return translate(prompt, maxOutputTokens, requireStructuredOutput);
  }

  void cancel();

  @Override
  void close() throws TranslationRuntimeCleanupException;
}
