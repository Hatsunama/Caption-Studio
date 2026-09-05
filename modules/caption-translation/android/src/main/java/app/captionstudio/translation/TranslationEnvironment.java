package app.captionstudio.translation;

import java.io.File;

interface TranslationEnvironment {
  File prepareCacheDirectory() throws NaturalCaptionTranslator.TranslationFailure;

  default File prepareCheckpointDirectory() throws NaturalCaptionTranslator.TranslationFailure {
    return null;
  }

  void verifyDeviceCapacity(File model) throws NaturalCaptionTranslator.TranslationFailure;
}
