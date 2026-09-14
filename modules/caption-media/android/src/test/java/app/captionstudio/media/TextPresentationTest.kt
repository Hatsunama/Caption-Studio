package app.captionstudio.media

import android.graphics.Bitmap
import android.graphics.Canvas
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TextPresentationTest {
  private fun style() = parseTextStyle(mapOf(
    "font" to mapOf("source" to "system", "family" to "sans-serif"),
    "stroke" to mapOf("width" to 2, "color" to "#000000"),
    "shadow" to mapOf("opacity" to 0.4, "blur" to 3, "offsetX" to 2, "offsetY" to 3),
    "background" to mapOf("paddingX" to 8, "paddingY" to 5),
    "position" to mapOf("x" to 0.5, "y" to 0.5),
    "box" to mapOf("width" to 0.8, "height" to 0.6),
    "animation" to mapOf("id" to "none", "durationMs" to 1000),
  ))
  private fun cue(text: String, style: RenderTextStyle = style()) = RenderCaption("cue", text, 0, 2000, style, emptyList())

  @Test fun authoredLineBreaksAndBlankLinesSurviveEveryBundledFont() {
    val fonts = File("assets/fonts").listFiles { file -> file.extension == "ttf" }!!.toList()
    assertTrue(fonts.size > 50)
    val fits = mutableSetOf<Float>()
    TimelineTextPainter(RuntimeEnvironment.getApplication()).use { painter ->
      for (font in fonts) {
        val text = "AgjQ e\u0301\n\n\u4e16\u754c \u0645\u0631\u062d\u0628\u0627 \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb\n"
        val caption = cue(text, style().copy(fontSource = "imported", fontUri = font.toURI().toString(), maxLines = 1))
        val fitted = painter.presentationFor(caption, emptyList(), 360, 640, true)
        assertEquals(font.name, text, fitted.authoredText)
        assertEquals(font.name, 4, fitted.layout.lineCount)
        assertTrue(font.name, fitted.fit > 0f && fitted.fit <= 1f)
        assertTrue(font.name, fitted.bounds.width() * fitted.fit <= 288.01f)
        assertTrue(font.name, fitted.bounds.height() * fitted.fit <= 384.01f)
        fits += fitted.fit
      }
    }
    assertTrue("Fitting must reflect actual typeface metrics", fits.size > 5)
  }

  @Test fun longLatinCjkRtlAndEmojiHaveNoMinimumFontFloor() {
    TimelineTextPainter(RuntimeEnvironment.getApplication()).use { painter ->
      for (text in listOf("W".repeat(3000), "\u4e16\u754c".repeat(1000), "\u0645\u0631\u062d\u0628\u0627 ".repeat(500), "\ud83d\udc69\u200d\ud83d\udcbb".repeat(1000))) {
        val caption = cue(text, style().copy(boxWidth = 0.1f, boxHeight = 0.05f))
        val fitted = painter.presentationFor(caption, emptyList(), 360, 640, true)
        assertEquals(text, fitted.authoredText)
        assertEquals(1, fitted.layout.lineCount)
        assertTrue(fitted.fit < 0.01f)
        assertTrue(fitted.bounds.width() * fitted.fit <= 36.01f)
        assertTrue(fitted.bounds.height() * fitted.fit <= 32.01f)
      }
    }
  }

  @Test fun unbrokenCaptionTokensFitAndAlignmentUsesTheWholeBox() {
    TimelineTextPainter(RuntimeEnvironment.getApplication()).use { painter ->
      val long = painter.presentationFor(cue("W".repeat(3000)), emptyList(), 360, 640, false)
      assertTrue(long.bounds.width() * long.fit <= 288.01f)
      val left = painter.presentationFor(cue("short", style().copy(alignment = "left")), emptyList(), 360, 640, false)
      val right = painter.presentationFor(cue("short", style().copy(alignment = "right")), emptyList(), 360, 640, false)
      assertEquals(left.layout.width, right.layout.width)
      assertTrue(left.layout.getLineLeft(0) < right.layout.getLineLeft(0))
    }
  }

  @Test fun alternatingCaptionsReuseTheirMeasuredPresentation() {
    TimelineTextPainter(RuntimeEnvironment.getApplication()).use { painter ->
      val firstCue = cue("first")
      val first = painter.presentationFor(firstCue, emptyList(), 360, 640, false)
      painter.presentationFor(cue("second"), emptyList(), 360, 640, false)
      assertSame(first, painter.presentationFor(firstCue, emptyList(), 360, 640, false))
    }
  }

  @Test fun geometryDoesNotRefitAndNativePreviewMatchesExportForCaptionAndText() {
    TimelineTextPainter(RuntimeEnvironment.getApplication()).use { painter ->
      val original = cue("Hello\n\u4e16\u754c \ud83d\udc4b")
      val scaled = original.copy(style = original.style.copy(scale = 2f, scaleX = 0.6f, scaleY = 1.7f, rotation = 23f))
      assertSame(painter.presentationFor(original, emptyList(), 360, 640, true), painter.presentationFor(scaled, emptyList(), 360, 640, true))
      for (authored in listOf(true, false)) {
        val preview = Bitmap.createBitmap(360, 640, Bitmap.Config.ARGB_8888)
        val exported = Bitmap.createBitmap(360, 640, Bitmap.Config.ARGB_8888)
        painter.drawPreview(Canvas(preview), scaled, 500, 360, 640, authored, false)
        if (authored) painter.drawTextLayer(Canvas(exported), TextRenderLayer("text", true, scaled.text, 0, 2000, scaled.style), 500, 360, 640)
        else painter.drawCaption(Canvas(exported), scaled, 500, 360, 640)
        assertTrue(preview.sameAs(exported))
        preview.recycle()
        exported.recycle()
      }
    }
  }

  @Test fun animationInkStaysInsideTheBoxAndEditingUsesTheSameFit() {
    val phraseIds = checkNotNull(javaClass.classLoader?.getResourceAsStream("caption-animation-contract.csv"))
      .bufferedReader().useLines { lines -> lines.drop(1).filter(String::isNotBlank).map { it.substringBefore(',') }.toList() }
    val ids = phraseIds + listOf("pop", "bounce", "punch", "wave", "word-spin", "word-slide", "word-flash", "word-jitter",
      "word-rise", "word-drop", "word-zoom", "word-tilt", "word-wobble", "word-squash", "word-stretch", "word-fade", "word-drift", "word-kick", "word-breathe")
    TimelineTextPainter(RuntimeEnvironment.getApplication()).use { painter ->
      for (id in ids.distinct()) {
        val caption = cue("AgjQ wide", style().copy(animationId = id, animationIntensity = 1f))
        val words = playbackTimedCaptionWords(caption)
        val fitted = painter.presentationFor(caption, words, 360, 640, false)
        for (time in listOf(125L, 333L, 750L, 1250L)) {
          val bitmap = Bitmap.createBitmap(360, 640, Bitmap.Config.ARGB_8888)
          painter.drawCaption(Canvas(bitmap), caption, time, 360, 640)
          val pixels = IntArray(360 * 640)
          bitmap.getPixels(pixels, 0, 360, 0, 0, 360, 640)
          for (y in 0 until 640) for (x in 0 until 360) {
            if ((pixels[y * 360 + x] ushr 24) > 16) {
              assertTrue("$id at $time escaped at $x,$y", x in 35..325 && y in 127..513)
            }
          }
          bitmap.recycle()
        }
        assertSame(fitted, painter.presentationFor(caption, words, 360, 640, false))
      }
    }
  }

  @Test fun nativeScaleSerializationDefaultsToIdentityAndRejectsInvalidValues() {
    val base = style()
    assertEquals(1f, base.scale)
    assertEquals(1f, base.scaleX)
    assertEquals(1f, base.scaleY)
    for (invalid in listOf(0, -1, Double.NaN, Double.POSITIVE_INFINITY, Double.MAX_VALUE)) {
      assertThrows(IllegalArgumentException::class.java) { mapOf<String, Any>("scaleX" to invalid).positiveScale("scaleX") }
    }
    assertEquals(2000f, mapOf<String, Any>("scaleX" to 2000).positiveScale("scaleX"))
  }
}
