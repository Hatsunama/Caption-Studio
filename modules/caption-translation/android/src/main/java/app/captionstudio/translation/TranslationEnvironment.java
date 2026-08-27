package app.captionstudio.translation;

import java.io.File;

interface TranslationEnvironment {
  File prepareCacheDirectory() throws NaturalCaptionTranslator.TranslationFailure;

  void verifyDeviceCapacity(File model) throws NaturalCaptionTranslator.TranslationFailure;
}
