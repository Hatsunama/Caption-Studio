package app.captionstudio.translation;

import static org.junit.Assert.*;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public final class UrduRemovalTest {
  @Test public void rejectsUrduSourceTargetAndIdentityAtBatchAndSessionBoundaries() {
    for (String tag : List.of("ur", "ur-PK", "ur-IN")) {
      for (String[] pair : List.of(new String[] {tag, "en"}, new String[] {"en", tag},
          new String[] {tag, tag})) {
        var captions = List.of(Map.of("id", "cue", "text", "Hello"));
        var batch = Map.<String, Object>of("sourceLanguage", pair[0], "targetLanguage", pair[1],
            "captions", captions);
        var session = Map.<String, Object>of("operations", List.of(Map.of("id", "operation",
            "sourceLanguage", pair[0], "targetLanguage", pair[1],
            "batches", List.of(Map.of("captions", captions)))));
        var batchFailure = assertThrows(NaturalCaptionTranslator.TranslationFailure.class,
            () -> NaturalCaptionTranslator.validateRequest(batch));
        var sessionFailure = assertThrows(NaturalCaptionTranslator.TranslationFailure.class,
            () -> NaturalCaptionTranslator.validateSessionRequest(session));
        assertEquals("E_TRANSLATION_INVALID_REQUEST", batchFailure.code);
        assertEquals("E_TRANSLATION_INVALID_REQUEST", sessionFailure.code);
        assertTrue(batchFailure.getMessage().contains("unsupported language"));
        assertTrue(sessionFailure.getMessage().contains("unsupported language"));
      }
    }
  }
}
