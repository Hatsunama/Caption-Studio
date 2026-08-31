package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

class TimelineTextPainterAnimationTest {
  @Test
  fun captionClockUsesCaptionStartAndKeepsContinuousPhase() {
    assertEquals(CaptionAnimationClock(0f, 0f), captionAnimationClock(1_000, 1_000, 3_000, 400))
    assertEquals(CaptionAnimationClock(1f, 2.25f), captionAnimationClock(1_900, 1_000, 3_000, 400))
  }

  @Test
  fun nativePhraseStatesMatchSharedPreviewContractFixture() {
    val clock = captionAnimationClock(1_050, 1_000, 3_000, 400)
    assertEquals(CaptionAnimationClock(0.125f, 0.125f), clock)
    val resource = checkNotNull(javaClass.classLoader?.getResourceAsStream("caption-animation-contract.csv"))
    resource.bufferedReader().useLines { lines ->
      lines.drop(1).filter(String::isNotBlank).forEach { line ->
        val fields = line.split(',')
        val state = captionAnimationState(fields[0], clock, 0.5f)
        val actual = floatArrayOf(state.translateX, state.translateY, state.scaleX, state.scaleY, state.rotation, state.alpha, state.glow)
        fields.drop(1).forEachIndexed { index, expected ->
          assertTrue("${fields[0]} field $index was ${actual[index]}", abs(actual[index] - expected.toFloat()) < 0.0001f)
        }
      }
    }
  }

  @Test
  fun missingInvalidOrMismatchedWordsNeverBecomeSyntheticTiming() {
    val style = renderTextStyle()
    val validWords = listOf(
      RenderWord("real", 1_000, 1_200, style),
      RenderWord("timing", 1_250, 1_500, style),
    )
    val validCaption = RenderCaption("valid", "real timing", 1_000, 1_500, style, validWords)
    assertEquals(validWords, realTimedCaptionWords(validCaption))
    assertTrue(realTimedCaptionWords(validCaption.copy(words = emptyList())).isEmpty())
    assertTrue(realTimedCaptionWords(validCaption.copy(words = listOf(RenderWord("real", 1_000, 1_000, style)))).isEmpty())
    assertTrue(realTimedCaptionWords(validCaption.copy(words = listOf(RenderWord("different", 1_000, 1_500, style)))).isEmpty())
    val spread = playbackTimedCaptionWords(validCaption.copy(text = "real timing extra", words = emptyList()))
    assertEquals(3, spread.size)
    assertEquals(1_000L, spread.first().startMs)
    assertEquals(1_500L, spread.last().endMs)
    assertTrue(spread.all { it.endMs > it.startMs })
    val rounded = playbackTimedCaptionWords(
      RenderCaption("spread", "a b c", 0L, 1_000L, style, emptyList()),
    )
    assertEquals(listOf(0L to 333L, 333L to 667L, 667L to 1_000L), rounded.map { it.startMs to it.endMs })
  }

  @Test
  fun wordTimedCaptionsMatchTheSharedMixedScriptAndPunctuationContract() {
    val style = renderTextStyle()
    val resource = checkNotNull(javaClass.classLoader?.getResourceAsStream("caption-word-timing-contract.tsv"))
    resource.bufferedReader().useLines { lines ->
      lines.drop(1).filter(String::isNotBlank).forEach { line ->
        val fields = line.split('\t')
        val valid = fields[0] == "true"
        val timed = fields[2].split('␞').mapIndexed { index, text ->
          RenderWord(text, index * 200L, (index + 1L) * 200L, style)
        }
        val caption = RenderCaption("fixture", fields[1], 0L, timed.size * 200L, style, timed)
        val aligned = realTimedCaptionWords(caption)
        assertEquals(fields[1], valid, aligned.isNotEmpty())
        val expected = if (fields[3] == "<empty>") emptyList() else fields[3].split('␞')
        assertEquals(fields[1], expected, aligned.map(RenderWord::text))
      }
    }
  }

  @Test
  fun packedCjkTimingSplitsOnGraphemesWithoutSplittingAstralCharacters() {
    val style = renderTextStyle()
    val caption = RenderCaption(
      "packed",
      "𠮷好",
      100L,
      300L,
      style,
      listOf(RenderWord("𠮷好", 100L, 300L, style)),
    )
    assertEquals(
      listOf("𠮷" to (100L to 200L), "好" to (200L to 300L)),
      realTimedCaptionWords(caption).map { it.text to (it.startMs to it.endMs) },
    )
  }

  private fun renderTextStyle() = RenderTextStyle(
    fontSource = "system",
    fontFamily = "sans-serif",
    fontUri = null,
    fontSize = 48f,
    fontWeight = 800,
    italic = false,
    textColor = "#FFFFFF",
    secondaryTextColor = "#FFFFFF",
    textTreatment = "solid",
    activeWordColor = "#FFFF00",
    strokeColor = "#000000",
    strokeWidth = 0f,
    shadowColor = "#000000",
    shadowOpacity = 0f,
    shadowBlur = 0f,
    shadowOffsetX = 0f,
    shadowOffsetY = 0f,
    backgroundColor = "#000000",
    backgroundOpacity = 0f,
    backgroundRadius = 0f,
    backgroundPaddingX = 0f,
    backgroundPaddingY = 0f,
    alignment = "center",
    letterSpacing = 0f,
    lineHeight = 1f,
    textTransform = "none",
    positionX = 0.5f,
    positionY = 0.78f,
    boxWidth = 0.86f,
    boxHeight = 0.2f,
    rotation = 0f,
    maxLines = 2,
    animationId = "none",
    animationIntensity = 0f,
    animationDurationMs = 1,
  )
}
