package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TimelineFractionalCaptionTest {
  private val style = mapOf<String, Any>(
    "font" to emptyMap<String, Any>(), "stroke" to emptyMap<String, Any>(),
    "shadow" to emptyMap<String, Any>(), "background" to emptyMap<String, Any>(),
    "position" to emptyMap<String, Any>(), "box" to emptyMap<String, Any>(),
    "animation" to emptyMap<String, Any>(),
  )

  private fun captionValue(text: String, start: Double, end: Double, words: List<Triple<String, Double, Double>>) =
    mapOf<String, Any>(
      "id" to "fraction", "text" to text, "startMs" to start, "endMs" to end, "style" to style,
      "words" to words.map { (word, from, to) -> mapOf<String, Any>(
        "text" to word, "startMs" to from, "endMs" to to, "style" to style,
      ) },
    )

  private fun caption(text: String, start: Double, end: Double, words: List<Triple<String, Double, Double>>) =
    parseCaption(captionValue(text, start, end, words))

  @Test
  fun actualMapParserAndPainterKeepEveryFractionalWord() {
    val expected = listOf(Triple("a", 1000.0, 1000.25), Triple("b", 1000.25, 1000.5))
    val parsed = caption("a b", 1000.0, 1000.5, expected)
    assertEquals(1000.0, parsed.startMs.toDouble(), 0.0)
    assertEquals(1000.5, parsed.endMs.toDouble(), 0.0)
    assertTrue(parsed.words.all { it.endMs > it.startMs })
    assertEquals(expected, parsed.words.map { Triple(it.text, it.startMs.toDouble(), it.endMs.toDouble()) })
    assertEquals(expected, realTimedCaptionWords(parsed).map { Triple(it.text, it.startMs.toDouble(), it.endMs.toDouble()) })
    assertEquals(realTimedCaptionWords(parsed), playbackTimedCaptionWords(parsed))
  }

  @Test
  fun packedFractionalWordsKeepSharedBoundariesAndExactParentEnds() {
    data class Case(val text: String, val start: Double, val end: Double, val expected: List<Pair<Double, Double>>)
    for ((text, start, end, expected) in listOf(
      Case("a b", 1000.0, 1000.5, listOf(1000.0 to 1000.25, 1000.25 to 1000.5)),
      Case("a b", 1000.25, 1001.75, listOf(1000.25 to 1001.0, 1001.0 to 1001.75)),
      Case("single", 1000.25, 1001.75, listOf(1000.25 to 1001.75)),
      Case("a bb ccc", 1000.0, 1200.0, listOf(1000.0 to 1033.0, 1033.0 to 1100.0, 1100.0 to 1200.0)),
    )) {
      val parsed = caption(text, start, end, listOf(Triple(text, start, end)))
      assertEquals(expected, realTimedCaptionWords(parsed).map { it.startMs.toDouble() to it.endMs.toDouble() })
    }
  }

  @Test
  fun renderPlanAcceptsSubmillisecondCueAndKeepsLeadingWordWhenStartWouldRoundUp() {
    val expected = listOf(Triple("a", 1000.75, 1001.0), Triple("b", 1001.0, 1001.25))
    val value = mapOf<String, Any>(
      "version" to 1, "durationMs" to 2000, "width" to 1920, "height" to 1080,
      "videoTransform" to mapOf("position" to emptyMap<String, Any>()),
      "captions" to listOf(captionValue("a b", 1000.75, 1001.25, expected)),
    )
    val parsed = parseTimelineRenderPlan(value).captions.single()
    assertEquals(1000.75, parsed.startMs, 0.0)
    assertEquals(1001.25, parsed.endMs, 0.0)
    val words = realTimedCaptionWords(parsed)
    assertEquals(expected, words.map { Triple(it.text, it.startMs, it.endMs) })
    assertFalse(words[0].isActiveAt(1000))
    assertFalse(words[0].isActiveAt(1001))
    assertTrue(words[1].isActiveAt(1001))
    assertFalse(words[1].isActiveAt(1002))
    assertNull(captionCueProgress(1000, parsed.startMs, parsed.endMs))
    assertEquals(0.5f, captionCueProgress(1001, parsed.startMs, parsed.endMs)!!, 0f)
    assertEquals(CaptionAnimationClock(0.25f, 0.000625f), captionAnimationClock(1001, parsed.startMs, parsed.endMs, 400))
    assertThrows(IllegalArgumentException::class.java) {
      caption("a", 0.0, 1.0, listOf(Triple("a", Double.NaN, 1.0)))
    }
  }
}
