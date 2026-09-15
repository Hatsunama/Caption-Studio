package app.captionstudio.translation;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Lossless source partitioning before tokenization. Never splits a surrogate pair. */
final class TranslationText {
  static final int FRAGMENT_BYTES = 480;
  private TranslationText() {}

  static boolean wellFormed(String text) {
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      if (Character.isHighSurrogate(c)) {
        if (++i == text.length() || !Character.isLowSurrogate(text.charAt(i))) return false;
      } else if (Character.isLowSurrogate(c)) return false;
    }
    return true;
  }

  static int bytes(String text) {
    return text.getBytes(StandardCharsets.UTF_8).length;
  }

  static int escapedBytes(int cp) {
    if (cp < 32 || cp == '<' || cp == '>') return 6;
    if (cp == '"' || cp == '\\') return 2;
    return cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }

  static List<String> split(String text) {
    if (!wellFormed(text)) throw new IllegalArgumentException("invalid-source-unicode");
    List<String> parts = new ArrayList<>();
    int start = 0;
    while (start < text.length()) {
      int end = start;
      int bytes = 0;
      int preferred = -1;
      int safe = -1;
      while (end < text.length()) {
        int cp = text.codePointAt(end);
        int cost = escapedBytes(cp);
        if (bytes + cost > FRAGMENT_BYTES) break;
        bytes += cost;
        end += Character.charCount(cp);
        if (safeBoundary(text, end)) {
          safe = end;
          if (Character.isWhitespace(cp) || ".!?;:。！？；".indexOf(cp) >= 0) preferred = end;
        }
      }
      if (end < text.length()) {
        end = preferred > start ? preferred : safe;
        // A single pathological combining/ZWJ sequence cannot fit the context.
        if (end <= start) throw new IllegalArgumentException("unsegmentable-source");
      }
      parts.add(text.substring(start, end));
      start = end;
    }
    return parts;
  }

  private static boolean safeBoundary(String text, int offset) {
    if (offset == text.length()) return true;
    int next = text.codePointAt(offset);
    int previous = text.codePointBefore(offset);
    int type = Character.getType(next);
    return next != 0x200d && previous != 0x200d
        && type != Character.NON_SPACING_MARK && type != Character.COMBINING_SPACING_MARK
        && type != Character.ENCLOSING_MARK && !(next >= 0x1f3fb && next <= 0x1f3ff)
        && !(previous >= 0x1f1e6 && previous <= 0x1f1ff && next >= 0x1f1e6 && next <= 0x1f1ff)
        && !(previous == '\r' && next == '\n');
  }
}
