package app.captionstudio.translation;

import static org.junit.Assert.*;
import com.google.gson.JsonArray;
import com.google.gson.JsonParser;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.Test;

public final class TranslationPreservationContractTest {
  @Test public void sharedNativeJsPreservationCorpus() throws Exception {
    try (var input = getClass().getResourceAsStream("/translation-preservation-contract.json")) {
      assertNotNull("shared preservation corpus must be on the test classpath", input);
      JsonArray cases = JsonParser.parseReader(new InputStreamReader(input, StandardCharsets.UTF_8)).getAsJsonArray();
      assertEquals(47, cases.size());
      for (var element : cases) {
        var item = element.getAsJsonObject();
        assertEquals(item.get("name").getAsString(), item.get("preserved").getAsBoolean(),
            TranslationPreservation.preserves(item.get("source").getAsString(), item.get("translated").getAsString()));
      }
    }
  }

  @Test public void sourcePartitionNeverSplitsProtectedLiteralsOrEmojiClusters() {
    String emoji = "\ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb\u0301";
    String url = "https://example.test/" + "a".repeat(700) + "/cafe\u0301";
    String code = "\u0060cafe\u0301_id=\"" + "<".repeat(100) + "\"\u0060";
    String source = "Hello ".repeat(8) + emoji + "\r\n" + url + " Hello " + code + " World";
    List<String> parts = TranslationPreservation.split(source, 60);
    assertEquals(source, String.join("", parts));
    assertTrue(parts.stream().anyMatch(p -> p.equals(url)));
    assertTrue(parts.stream().anyMatch(p -> p.equals(code)));
    assertEquals(1, parts.stream().filter(p -> p.contains(emoji)).count());
    for (String part : parts) assertTrue(TranslationText.wellFormed(part));
  }

  @Test public void integerFormsAreAcceptedWithoutTargetScriptFalsePositive() {
    for (String target : new String[] {"en", "fr", "zh-Hans", "ja", "ar"}) {
      assertEquals(TranslationOutputQuality.Reason.NONE,
          TranslationOutputQuality.classify("42", "\u0664\u0662", target));
    }
    assertEquals(TranslationOutputQuality.Reason.PROTECTED_CONTENT,
        TranslationOutputQuality.classify("42", "\u0664\u0663", "ar"));
  }

  @Test public void lineBreaksSurviveStrictParserBeforeQualityAndCheckpointAcceptance() throws Exception {
    String source = "\r\nHello\n\nWorld\r\n";
    var caption = NaturalCaptionTranslator.parseSingleCaptionRetryResponse(
        "[{\"id\":\"cue\",\"text\":\"\\nBonjour\\n\\nMonde\\n\"}]",
        new NaturalCaptionTranslator.Caption("cue", source));
    assertTrue(caption.valid);
    assertEquals("\nBonjour\n\nMonde\n", caption.text);
    assertFalse(TranslationOutputQuality.needsReview(source, caption.text, "fr"));
  }
}
