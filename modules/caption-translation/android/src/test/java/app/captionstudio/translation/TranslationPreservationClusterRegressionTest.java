package app.captionstudio.translation;

import static org.junit.Assert.*;
import org.junit.Test;

public final class TranslationPreservationClusterRegressionTest {
  private static final String DEVICE_CUE = "🙂 🚀 👨‍👩‍👧‍👦 ❤️‍🔥 + ++ = ±";

  @Test public void identicalDeviceCueRetainsItsOwnInventory() {
    assertTrue(TranslationPreservation.preserves(DEVICE_CUE, DEVICE_CUE));
  }
  @Test public void identicalDeviceCueIsAnInvariantComposition() {
    assertTrue(TranslationPreservation.invariantCompositionEquivalent(DEVICE_CUE, DEVICE_CUE));
    assertTrue(TranslationPreservation.protectedCompositionOnly(DEVICE_CUE));
    assertFalse(TranslationOutputQuality.needsReview(DEVICE_CUE, DEVICE_CUE, "ja"));
  }
  @Test public void existingClustersRemainValidInTranslatedProse() {
    assertTrue(TranslationPreservation.preserves("Use + ++ = ± now", "Utilisez + ++ = ± maintenant"));
  }
  @Test public void existingClustersCannotGainSelectedSymbols() {
    assertFalse(TranslationPreservation.preserves("Use + ++ now", "Utilisez + +++ maintenant"));
    assertFalse(TranslationPreservation.preserves("Use + ++ now", "Utilisez + ++++ maintenant"));
  }
  @Test public void existingClustersCannotLoseSelectedSymbols() {
    assertFalse(TranslationPreservation.preserves("Use + ++ now", "Utilisez + + maintenant"));
    assertFalse(TranslationPreservation.preserves("Use + ++ now", "Utilisez ++ maintenant"));
  }
  @Test public void unrequestedClustersBesideValidLiteralsRemainRejected() {
    assertFalse(TranslationPreservation.preserves("Use + now", "Utilisez + ++ maintenant"));
    assertFalse(TranslationPreservation.preserves("Use + now", "Utilisez +++ maintenant"));
  }
  @Test public void opaqueCodeAndUrlsDoNotSupplyOperatorCopies() {
    String source = "Use + ++ `x++` https://example.test/a++?q=+";
    String translated = "Utilisez + ++ `x++` https://example.test/a++?q=+";
    assertTrue(TranslationPreservation.preserves(source, translated));
    assertFalse(TranslationPreservation.preserves(source, translated + " +"));
    assertFalse(TranslationPreservation.preserves(source, translated.replace("`x++`", "`x+`")));
  }
  @Test public void attachedIdentifiersAndSignedNumbersRemainOutsideOperatorGate() {
    assertTrue(TranslationPreservation.preserves("C++ + -12 +42", "C++ + -12 +42"));
    assertTrue(TranslationPreservation.preserves("C++ + ++", "C++ + ++"));
  }
  @Test public void unicodeOperatorsUseTheSameSourceAndOutputInventory() {
    assertTrue(TranslationPreservation.preserves("Use ± ±± now", "Utilisez ± ±± maintenant"));
    assertFalse(TranslationPreservation.preserves("Use ± ±± now", "Utilisez ± ±±± maintenant"));
  }
}
