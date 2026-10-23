package app.captionstudio.media

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Layout
import android.text.SpannableString
import android.text.StaticLayout
import android.text.Spanned
import android.text.TextDirectionHeuristics
import android.text.TextPaint
import android.text.style.ReplacementSpan
import android.text.style.MetricAffectingSpan
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TextPresentationSpacingTest {
  private fun styleFields(lineHeight: Double = 1.0): Map<String, Any> = mapOf(
    "font" to mapOf("source" to "system", "family" to "sans-serif"),
    "stroke" to emptyMap<String, Any>(),
    "shadow" to emptyMap<String, Any>(),
    "background" to emptyMap<String, Any>(),
    "position" to emptyMap<String, Any>(),
    "box" to emptyMap<String, Any>(),
    "animation" to emptyMap<String, Any>(),
    "lineHeight" to lineHeight,
  )

  private fun style() = parseTextStyle(styleFields()).copy(
    fontSize = 48f, fontWeight = 800, italic = false,
    alignment = "left", letterSpacing = 0f, lineHeight = 1f,
    strokeWidth = 0f, shadowOpacity = 0f, textTreatment = "solid",
    backgroundOpacity = 0f, backgroundPaddingX = 0f, backgroundPaddingY = 0f,
    positionX = 0.5f, positionY = 0.5f, boxWidth = 0.9f, boxHeight = 0.8f,
    animationId = "none", animationIntensity = 0f, textTransform = "none",
  )

  private fun cue(text: String, style: RenderTextStyle): RenderCaption {
    val words = text.split(Regex("\\s+")).filter(String::isNotEmpty).mapIndexed { index, word ->
      RenderWord(word, index * 500L, (index + 1L) * 500L, style)
    }
    return RenderCaption("spacing", text, 0L, 2_000L, style, words)
  }

  private data class DrawnRun(val text: String, val x: Float, val y: Float, val advance: Float)

  private fun runs(presentation: TextPresentation): List<DrawnRun> {
    val bitmap = Bitmap.createBitmap(360, 640, Bitmap.Config.ARGB_8888)
    return try {
      buildList {
        presentation.draw(Canvas(bitmap)) { run, x, y, advance, _ ->
          add(DrawnRun(run.text, x, y, advance))
        }
      }
    } finally { bitmap.recycle() }
  }

  private fun gap(runs: List<DrawnRun>) = runs[1].x - runs[0].x - runs[0].advance

  @Test fun defaultShadowDoesNotAddItsPaddingBetweenTimedWords() {
    val plainStyle = style()
    val shadowStyle = plainStyle.copy(shadowOpacity = 0.75f, shadowBlur = 4f, shadowOffsetX = 3f, shadowOffsetY = 3f)
    TimelineTextPainter(RuntimeEnvironment.getApplication()).use { painter ->
      val plain = cue("Hello world", plainStyle)
      val decorated = cue("Hello world", shadowStyle)
      val plainRuns = runs(painter.presentationFor(plain, plain.words, 360, 640, false))
      val decoratedRuns = runs(painter.presentationFor(decorated, decorated.words, 360, 640, false))
      assertEquals(2, plainRuns.size)
      assertEquals(2, decoratedRuns.size)
      assertTrue("The authored space must remain visible", gap(decoratedRuns) > 0f)
      assertEquals("Shadow padding must be outside the phrase, not inside the word gap",
        gap(plainRuns), gap(decoratedRuns), 1f)
      // Compare unscaled glyph advances as well: shrinking the caption cannot fix this test.
      plainRuns.zip(decoratedRuns).forEach { (plainRun, decoratedRun) ->
        assertEquals(plainRun.advance, decoratedRun.advance, 0.01f)
      }
      val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply {
        textSize = plainStyle.fontSize
        typeface = Typeface.create(Typeface.create("sans-serif", Typeface.NORMAL), 800, false)
      }
      assertEquals("Word glyphs retain their authored size", paint.measureText("Hello"), decoratedRuns[0].advance, 0.01f)
    }
  }

  @Test fun strokeTreatmentAndWordAnimationDoNotChangeTypographicSpacing() {
    TimelineTextPainter(RuntimeEnvironment.getApplication()).use { painter ->
      val base = cue("Hello world", style())
      val reference = runs(painter.presentationFor(base, base.words, 360, 640, false))
      for (variant in listOf(
        style().copy(strokeWidth = 8f),
        style().copy(textTreatment = "duotone-neon"),
        style().copy(animationId = "pop", animationIntensity = 1f),
        style().copy(animationId = "word-slide", animationIntensity = 1f),
      )) {
        val caption = cue(base.text, variant)
        val actual = runs(painter.presentationFor(caption, caption.words, 360, 640, false))
        assertEquals("${variant.animationId}/${variant.textTreatment}: paint bounds changed advance",
          gap(reference), gap(actual), 1f)
        reference.zip(actual).forEach { (expected, run) -> assertEquals(expected.advance, run.advance, 0.01f) }
      }
    }
  }

  @Test fun decorationDoesNotInflateMultilineBaselineDistance() {
    TimelineTextPainter(RuntimeEnvironment.getApplication()).use { painter ->
      val plain = cue("Hello\nworld", style())
      val decorated = cue(plain.text, style().copy(strokeWidth = 3f, shadowOpacity = 0.75f,
        shadowBlur = 4f, shadowOffsetX = 3f, shadowOffsetY = 3f))
      val plainRuns = runs(painter.presentationFor(plain, plain.words, 360, 640, true))
      val decoratedRuns = runs(painter.presentationFor(decorated, decorated.words, 360, 640, true))
      assertEquals(2, plainRuns.size)
      assertEquals(2, decoratedRuns.size)
      assertEquals("Line height must use font metrics rather than shadow/stroke extents",
        plainRuns[1].y - plainRuns[0].y, decoratedRuns[1].y - decoratedRuns[0].y, 1f)
    }
  }

  @Test fun quarterHeightSurvivesNativeParsingAndMovesBaselinesWithoutSquashingGlyphs() {
    val parsed = parseTextStyle(styleFields(0.25))
    assertEquals("Native parser must accept the same slider floor as JS", 0.25f, parsed.lineHeight, 0f)
    assertEquals(0.25f, parseTextStyle(styleFields(-10.0)).lineHeight, 0f)
    TimelineTextPainter(RuntimeEnvironment.getApplication()).use { painter ->
      val normal = cue("Hello\nworld\nagain", style())
      val tight = cue(normal.text, normal.style.copy(lineHeight = parsed.lineHeight))
      val normalRuns = runs(painter.presentationFor(normal, normal.words, 360, 640, true))
      val tightRuns = runs(painter.presentationFor(tight, tight.words, 360, 640, true))
      assertEquals(3, normalRuns.size)
      assertEquals(3, tightRuns.size)
      val normalDistance = normalRuns[2].y - normalRuns[1].y
      val tightDistance = tightRuns[2].y - tightRuns[1].y
      assertTrue("The first baseline step must also stay forward", tightRuns[1].y > tightRuns[0].y)
      assertTrue("Overlapping lines must still advance forward", tightDistance > 0f)
      assertTrue("The quarter-height setting must allow substantial line overlap", tightDistance < normalDistance * 0.5f)
      // Compare with Android layout without replacement spans. A fixed fraction
      // of the baseline distance at 1x also scales padding/fallback contributions
      // that StaticLayout does not necessarily scale with its line multiplier.
      val referencePaint = TextPaint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply {
        textSize = normal.style.fontSize
        typeface = Typeface.create(Typeface.create("sans-serif", Typeface.NORMAL), 800, false)
      }
      val diagnosticRows = mutableListOf<String>()
      val baselineComparisons = mutableListOf<Triple<String, Float, Float>>()
      for ((caption, actual) in listOf(normal to normalRuns, tight to tightRuns)) {
        val reference = StaticLayout.Builder.obtain(caption.text, 0, caption.text.length, referencePaint, 324)
          .setIncludePad(true)
          .setLineSpacing(0f, caption.style.lineHeight)
          .setUseLineSpacingFromFallbacks(true)
          .setTextDirection(TextDirectionHeuristics.FIRSTSTRONG_LTR)
          .setAlignment(Layout.Alignment.ALIGN_NORMAL)
          .setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
          .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
          .build()
        assertEquals(3, reference.lineCount)
        val actualLayout = painter.presentationFor(caption, caption.words, 360, 640, true).layout
        val spanned = actualLayout.text as Spanned
        fun paintDetails(paint: Paint) = "size=${paint.textSize},flags=${paint.flags}," +
          "scaleX=${paint.textScaleX},skewX=${paint.textSkewX},letterSpacing=${paint.letterSpacing}," +
          "typeface=${paint.typeface},weight=${paint.typeface?.weight},style=${paint.typeface?.style}," +
          "elegant=${paint.isElegantTextHeight},locales=${paint.textLocales}," +
          "features=${paint.fontFeatureSettings},variations=${paint.fontVariationSettings},fm=${paint.fontMetricsInt}"
        val spanMetrics = spanned.getSpans(0, spanned.length, ReplacementSpan::class.java).map { span ->
          val fm = Paint.FontMetricsInt()
          span.getSize(actualLayout.paint, spanned, spanned.getSpanStart(span), spanned.getSpanEnd(span), fm)
          val measureField = span.javaClass.getDeclaredField("measure").apply { isAccessible = true }
          val measurePaint = measureField.get(span) as Paint
          "range=${spanned.getSpanStart(span)}..${spanned.getSpanEnd(span)},reported=$fm,paint=${paintDetails(measurePaint)}"
        }
        fun lines(layout: StaticLayout) = (0 until layout.lineCount).map { line ->
          "top=${layout.getLineTop(line)},baseline=${layout.getLineBaseline(line)}," +
            "ascent=${layout.getLineAscent(line)},descent=${layout.getLineDescent(line)}"
        }
        val markedText = caption.text.split('\n').joinToString("\n") { "\u200e$it" }
        val markedReference = StaticLayout.Builder.obtain(markedText, 0, markedText.length, referencePaint, 324)
          .setIncludePad(true).setLineSpacing(0f, caption.style.lineHeight)
          .setUseLineSpacingFromFallbacks(true).setTextDirection(TextDirectionHeuristics.FIRSTSTRONG_LTR)
          .setAlignment(Layout.Alignment.ALIGN_NORMAL).setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
          .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE).build()
        val exactText = actualLayout.text.toString()
        val exactCodePoints = exactText.codePoints().toArray().joinToString(" ") { "U+${it.toString(16).uppercase()}" }
        fun controlLayout(text: CharSequence, fallback: Boolean): StaticLayout = StaticLayout.Builder.obtain(
          text, 0, text.length, TextPaint(actualLayout.paint), actualLayout.width,
        ).setIncludePad(true).setLineSpacing(0f, caption.style.lineHeight)
          .setUseLineSpacingFromFallbacks(fallback).setTextDirection(TextDirectionHeuristics.FIRSTSTRONG_LTR)
          .setAlignment(Layout.Alignment.ALIGN_NORMAL).setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
          .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE).build()
        val segmentedText = SpannableString(exactText)
        val minimalReplacementText = SpannableString(exactText)
        spanned.getSpans(0, spanned.length, ReplacementSpan::class.java).forEach { span ->
          segmentedText.setSpan(object : MetricAffectingSpan() {
            override fun updateMeasureState(paint: TextPaint) = Unit
            override fun updateDrawState(paint: TextPaint) = Unit
          }, spanned.getSpanStart(span), spanned.getSpanEnd(span), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
          minimalReplacementText.setSpan(object : ReplacementSpan() {
            override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
              if (fm != null) paint.getFontMetricsInt(fm)
              return kotlin.math.ceil(paint.measureText(text, start, end).toDouble()).toInt()
            }
            override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int,
              x: Float, top: Int, y: Int, bottom: Int, paint: Paint) = Unit
          }, spanned.getSpanStart(span), spanned.getSpanEnd(span), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        val diagnostics = "lineHeight=${caption.style.lineHeight}; exactLayoutTextCodePoints=$exactCodePoints; width=${actualLayout.width}; " +
          "referencePaint=${paintDetails(referencePaint)}; actualPaint=${paintDetails(actualLayout.paint)}; " +
          "spanMetrics=$spanMetrics; referenceLines=${lines(reference)}; actualLines=${lines(actualLayout)}; " +
          "markedReferenceLines=${lines(markedReference)}; " +
          "exactUnspannedFallbackOn=${lines(controlLayout(exactText, true))}; " +
          "exactUnspannedFallbackOff=${lines(controlLayout(exactText, false))}; " +
          "actualSpannedFallbackOn=${lines(controlLayout(spanned, true))}; " +
          "actualSpannedFallbackOff=${lines(controlLayout(spanned, false))}; " +
          "sameTextMetricBoundariesFallbackOn=${lines(controlLayout(segmentedText, true))}; " +
          "sameTextMetricBoundariesFallbackOff=${lines(controlLayout(segmentedText, false))}; " +
          "minimalReplacementFallbackOn=${lines(controlLayout(minimalReplacementText, true))}; " +
          "minimalReplacementFallbackOff=${lines(controlLayout(minimalReplacementText, false))}"
        diagnosticRows += diagnostics
        for (line in 1 until reference.lineCount) {
          baselineComparisons += Triple("${caption.style.lineHeight}x line $line must match unspanned Android typography",
            (reference.getLineBaseline(line) - reference.getLineBaseline(line - 1)).toFloat(),
            actual[line].y - actual[line - 1].y)
        }
      }
      val allDiagnostics = diagnosticRows.joinToString("\n")
      baselineComparisons.forEach { (message, expected, actual) ->
        assertEquals("$message; $allDiagnostics", expected, actual, 1f)
      }
      normalRuns.zip(tightRuns).forEach { (expected, actual) -> assertEquals(expected.advance, actual.advance, 0f) }
    }
  }

  @Test fun tightDecoratedAnimatedInkFitsAndNativePreviewMatchesExport() {
    TimelineTextPainter(RuntimeEnvironment.getApplication()).use { painter ->
      for (animation in listOf("none", "pop", "word-slide", "glow-pulse")) {
        val caption = cue("AgjQ\nwide", style().copy(lineHeight = 0.25f, boxWidth = 0.6f, boxHeight = 0.3f,
          strokeWidth = 3f, shadowOpacity = 0.75f, shadowBlur = 4f, shadowOffsetX = 3f,
          shadowOffsetY = 3f, animationId = animation, animationIntensity = 1f))
        val fitted = painter.presentationFor(caption, caption.words, 360, 640, false)
        assertTrue(fitted.bounds.width() * fitted.fit <= 216.01f)
        assertTrue(fitted.bounds.height() * fitted.fit <= 192.01f)
        for (time in listOf(125L, 333L, 750L)) {
          val preview = Bitmap.createBitmap(360, 640, Bitmap.Config.ARGB_8888)
          val exported = Bitmap.createBitmap(360, 640, Bitmap.Config.ARGB_8888)
          try {
            painter.drawPreview(Canvas(preview), caption, time, 360, 640, false, false)
            painter.drawCaption(Canvas(exported), caption, time, 360, 640)
            assertTrue("$animation at $time: preview/export differ", preview.sameAs(exported))
            val pixels = IntArray(360 * 640)
            exported.getPixels(pixels, 0, 360, 0, 0, 360, 640)
            var visible = 0
            pixels.forEachIndexed { index, pixel ->
              if ((pixel ushr 24) > 16) {
                visible++
                val x = index % 360
                val y = index / 360
                assertTrue("$animation at $time escaped its fitted box at $x,$y",
                  abs(x - 180) <= 109 && abs(y - 320) <= 97)
              }
            }
            assertTrue("$animation at $time must actually draw ink", visible > 0)
          } finally { preview.recycle(); exported.recycle() }
        }
      }
    }
  }

  @Test fun wrappedRtlAndAuthoredMixedDirectionLinesKeepDecoratedAnimatedInkInsideTheBox() {
    val arabic = "\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645"
    TimelineTextPainter(RuntimeEnvironment.getApplication()).use { painter ->
      for (authored in listOf(false, true)) {
        val text = if (authored) "$arabic\nLatin $arabic" else "$arabic $arabic $arabic"
        for (animation in listOf("none", "word-spin", "wobble")) {
          val caption = cue(text, style().copy(
            fontSize = 54f, lineHeight = 0.25f, boxWidth = 0.45f, boxHeight = 0.42f,
            strokeWidth = 4f, shadowOpacity = 0.8f, shadowBlur = 8f,
            shadowOffsetX = -7f, shadowOffsetY = 5f,
            textTreatment = "duotone-neon", animationId = animation, animationIntensity = 1f,
          ))
          val words = if (authored) emptyList() else caption.words
          val fitted = painter.presentationFor(caption, words, 360, 640, authored)
          assertTrue("Fixture must exercise multiple lines: authored=$authored", fitted.layout.lineCount >= 2)
          assertTrue(fitted.bounds.width() * fitted.fit <= 162.01f)
          assertTrue(fitted.bounds.height() * fitted.fit <= 268.81f)
          for (time in listOf(125L, 625L, 1_125L, 1_625L)) {
            val preview = Bitmap.createBitmap(360, 640, Bitmap.Config.ARGB_8888)
            val exported = Bitmap.createBitmap(360, 640, Bitmap.Config.ARGB_8888)
            try {
              painter.drawPreview(Canvas(preview), caption, time, 360, 640, authored, false)
              if (authored) {
                painter.drawTextLayer(Canvas(exported), TextRenderLayer("rtl-text", true, text, 0L, 2_000L, caption.style), time, 360, 640)
              } else {
                painter.drawCaption(Canvas(exported), caption, time, 360, 640)
              }
              assertTrue("RTL preview/export differ: authored=$authored $animation at $time", preview.sameAs(exported))
              val pixels = IntArray(360 * 640)
              exported.getPixels(pixels, 0, 360, 0, 0, 360, 640)
              var visible = 0
              pixels.forEachIndexed { index, pixel ->
                if ((pixel ushr 24) > 16) {
                  visible++
                  val x = index % 360
                  val y = index / 360
                  assertTrue("RTL ink escaped: authored=$authored $animation at $time ($x,$y)",
                    abs(x - 180) <= 82 && abs(y - 320) <= 136)
                }
              }
              assertTrue("RTL fixture must render visible ink: authored=$authored $animation at $time", visible > 0)
            } finally { preview.recycle(); exported.recycle() }
          }
        }
      }
    }
  }
}
