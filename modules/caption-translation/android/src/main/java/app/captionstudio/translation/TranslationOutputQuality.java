package app.captionstudio.translation;

import java.text.Normalizer;
import java.util.Locale;
import java.util.regex.Pattern;

/** Script screening cannot prove translation accuracy. Human edits remain authoritative. */
final class TranslationOutputQuality {
  private TranslationOutputQuality() {}

  static boolean needsReview(String sourceText, String translatedText, String target) {
    String source = Normalizer.normalize(sourceText, Normalizer.Form.NFC).trim();
    String text = Normalizer.normalize(translatedText, Normalizer.Form.NFC).trim();
    if (text.isEmpty() || text.codePointCount(0, text.length()) > 500) return true;
    String sourceAck = acknowledgement(source);
    String targetAck = acknowledgement(text);
    if (sourceAck.equals("ok") || sourceAck.equals("okay")) {
      if (targetAck.equals("ok")) return false;
      if (targetAck.equals("okay") && target.matches("en|es|fr|pt|id|de|tr|vi|it|pl")) return false;
    }
    if (source.equals(text)) {
      if (!has(text, "\\p{L}") || text.matches("https?://[^\\s]+")) return false;
      return true;
    }
    switch (target) {
      case "zh-Hans": case "zh-Hant": return !has(text, "\\p{IsHan}");
      case "ja": return !has(text, "[\\p{IsHiragana}\\p{IsKatakana}\\p{IsHan}]");
      case "ko": return !has(text, "\\p{IsHangul}");
      case "th": return !has(text, "\\p{IsThai}");
      case "ar": case "ur": return !has(text, "\\p{IsArabic}");
      case "hi": return !has(text, "\\p{IsDevanagari}");
      case "bn": return !has(text, "\\p{IsBengali}");
      case "ru": return !has(text, "\\p{IsCyrillic}");
      case "en": return has(text, "\\p{IsHan}");
      default: return !has(text, "\\p{IsLatin}");
    }
  }

  private static String acknowledgement(String text) {
    return text.toLowerCase(Locale.ROOT).replaceAll("[\\s\\p{P}\\p{Z}]", "");
  }

  private static boolean has(String text, String expression) {
    return Pattern.compile(expression).matcher(text).find();
  }
}
