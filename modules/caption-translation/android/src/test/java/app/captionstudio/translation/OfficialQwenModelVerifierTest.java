package app.captionstudio.translation;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.File;
import org.junit.Test;

public final class OfficialQwenModelVerifierTest {
  @Test public void unreadableExpectedSizeModelIsNotClassifiedAsInvalidTranslationRequest() {
    File missing = new File("missing-qwen-model.litertlm") {
      @Override public long length() { return OfficialQwenModelVerifier.EXPECTED_MODEL_BYTES; }
    };
    NaturalCaptionTranslator.TranslationFailure failure = assertThrows(
        NaturalCaptionTranslator.TranslationFailure.class,
        () -> new OfficialQwenModelVerifier().verify(missing, () -> false, ignored -> {})
    );
    assertEquals("E_TRANSLATION_MODEL_READ", failure.code);
  }
}
