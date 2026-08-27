package app.captionstudio.translation;

interface TranslationRuntime extends AutoCloseable {
  String translate(String prompt) throws Exception;

  void cancel();

  @Override
  void close() throws TranslationRuntimeCleanupException;
}
