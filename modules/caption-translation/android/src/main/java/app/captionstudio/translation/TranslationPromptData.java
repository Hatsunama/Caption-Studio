package app.captionstudio.translation;

import java.util.HashMap;
import java.util.Map;

final class TranslationPromptData {
  private TranslationPromptData() {}

  static String escape(String json) {
    return json.replace("<|", "\\u003c|")
        .replace("<tool_call>", "\\u003ctool_call>")
        .replace("</tool_call>", "\\u003c/tool_call>");
  }

  static int escapedBytesAt(String text, int offset) {
    if (text.charAt(offset) == '<' && (text.startsWith("<|", offset)
        || text.startsWith("<tool_call>", offset)
        || text.startsWith("</tool_call>", offset))) return 6;
    return TranslationText.escapedBytes(text.codePointAt(offset));
  }

  static int chatMarkerEnd(String text, int start) {
    if (!text.startsWith("<|", start)) return start;
    int end = start + 2;
    while (end < text.length()) {
      int cp = text.codePointAt(end);
      if (cp == '<' || cp == '\u0060' || cp == '"' || whitespace(cp)) break;
      end += Character.charCount(cp);
      if (cp == '>') break;
    }
    return end;
  }

  private static boolean whitespace(int cp) {
    return (cp >= 9 && cp <= 13) || cp == 32 || cp == 0x85 || cp == 0xa0
        || cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp == 0x2028
        || cp == 0x2029 || cp == 0x202f || cp == 0x205f || cp == 0x3000 || cp == 0xfeff;
  }

  private static Map<String, Integer> chatMarkers(String text) {
    Map<String, Integer> counts = new HashMap<>();
    int at = 0;
    while ((at = text.indexOf("<|", at)) >= 0) {
      int end = chatMarkerEnd(text, at);
      String marker = text.substring(at, end);
      counts.put(marker, counts.getOrDefault(marker, 0) + 1);
      at = end;
    }
    return counts;
  }

  static boolean chatMarkersMatch(String source, String translated) {
    return chatMarkers(source).equals(chatMarkers(translated));
  }
}
