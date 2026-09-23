package app.captionstudio.translation;

import java.io.File;
import java.util.function.BooleanSupplier;

interface TranslationRuntimeFactory {
  default TranslationRuntime open(
      File model, File cacheDirectory, int threadCount, String systemInstruction,
      TranslationBackendSelection.Preference preference, BooleanSupplier cancelled
  ) throws Exception {
    return open(model, cacheDirectory, threadCount, systemInstruction);
  }

  TranslationRuntime open(
      File model,
      File cacheDirectory,
      int threadCount,
      String systemInstruction
  ) throws Exception;
}
