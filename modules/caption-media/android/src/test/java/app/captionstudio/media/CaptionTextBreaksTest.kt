package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptionTextBreaksTest {
  @Test
  fun wrapsChineseAtCharacterBoundariesWithoutBreakingLatinWords() {
    assertEquals(
      listOf("你", "好", "，", "世", "界", "Caption", "Studio"),
      CaptionTextBreaks.tokens("你好，世界 Caption Studio"),
    )
  }

  @Test
  fun marksCjkAndPunctuationForCompactSpacing() {
    assertTrue(CaptionTextBreaks.usesCompactSpacing("你"))
    assertTrue(CaptionTextBreaks.usesCompactSpacing("，"))
    assertFalse(CaptionTextBreaks.usesCompactSpacing("Caption"))
  }

  @Test
  fun preservesEmojiAsOneToken() {
    assertEquals(listOf("字", "👩🏽‍💻", "幕"), CaptionTextBreaks.tokens("字👩🏽‍💻幕"))
  }
}
