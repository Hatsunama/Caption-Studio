package app.captionstudio.translation;

import java.io.File;
import java.util.function.BooleanSupplier;
import java.util.function.IntConsumer;

interface TranslationModelVerifier {
  void verify(
      File model,
      BooleanSupplier cancelled,
      IntConsumer progress
  ) throws NaturalCaptionTranslator.TranslationFailure;
}
