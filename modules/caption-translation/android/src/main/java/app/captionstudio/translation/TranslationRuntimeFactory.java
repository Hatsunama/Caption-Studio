package app.captionstudio.translation;

import java.io.File;

interface TranslationRuntimeFactory {
  TranslationRuntime open(
      File model,
      File cacheDirectory,
      int threadCount,
      String systemInstruction
  ) throws Exception;
}
