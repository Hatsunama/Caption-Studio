package app.captionstudio.translation;

import static org.junit.Assert.*;
import org.junit.Test;

public final class TranslationPreservationCountsTest {
  @Test public void addedCopyOfSourceEmojiIsRejected() {
    assertFalse(TranslationPreservation.preserves("Hello \ud83d\ude00", "Bonjour \ud83d\ude00\ud83d\ude00"));
  }
  @Test public void repeatedSourceEmojiCannotGainAnotherCopy() {
    assertFalse(TranslationPreservation.preserves("Hello \ud83d\ude00\ud83d\ude00", "Bonjour \ud83d\ude00\ud83d\ude00\ud83d\ude00"));
  }
  @Test public void sourceUrlCannotGainAnotherCopy() {
    assertFalse(TranslationPreservation.preserves("Read https://example.test/a", "Lisez https://example.test/a https://example.test/a"));
  }
  @Test public void sourceCodeCannotGainAnotherCopy() {
    assertFalse(TranslationPreservation.preserves("Run \u0060x=42\u0060", "Executez \u0060x=42\u0060 \u0060x=42\u0060"));
  }
  @Test public void duplicatedEmojiCannotPassNativeQualityAcceptance() {
    assertTrue(TranslationOutputQuality.needsReview("Hello \ud83d\ude00", "Bonjour \ud83d\ude00\ud83d\ude00", "fr"));
  }
  @Test public void equalRepeatedCountsStillPass() {
    assertTrue(TranslationPreservation.preserves("Hello \ud83d\ude00\ud83d\ude00", "Bonjour \ud83d\ude00\ud83d\ude00"));
    assertFalse(TranslationOutputQuality.needsReview("Hello \ud83d\ude00\ud83d\ude00", "Bonjour \ud83d\ude00\ud83d\ude00", "fr"));
  }
}
