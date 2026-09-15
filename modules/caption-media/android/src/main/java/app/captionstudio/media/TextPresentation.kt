package app.captionstudio.media

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextDirectionHeuristics
import android.text.TextPaint
import android.text.style.ReplacementSpan
import java.text.Bidi
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.cos
import kotlin.math.sin

internal data class PresentationRun(val text: String, val style: RenderTextStyle, val timedIndex: Int)
internal typealias DrawPresentationRun = (PresentationRun, Float, Float, Float, Float) -> Unit

internal class TextPresentation private constructor(
  val layout: StaticLayout,
  val fit: Float,
  val bounds: RectF,
  val authoredText: String,
  private val dispatch: RunDispatch,
) {
  fun draw(canvas: Canvas, draw: DrawPresentationRun) {
    dispatch.draw = draw
    try { layout.draw(canvas) } finally { dispatch.draw = null }
  }

  internal class RunDispatch { var draw: DrawPresentationRun? = null }

  companion object {
    fun fit(
      rawText: String,
      words: List<RenderWord>,
      style: RenderTextStyle,
      boxWidth: Float,
      boxHeight: Float,
      authored: Boolean,
      paint: (RenderTextStyle) -> Paint,
      wordStates: (RenderTextStyle, Int) -> List<TextAnimationState>,
    ): TextPresentation {
      val text = rawText.replace("\r\n", "\n").replace('\r', '\n')
      val dispatch = RunDispatch()
      val content = SpannableStringBuilder()
      val runs = mutableListOf<PresentationRun>()
      var cursor = 0
      words.forEachIndexed { index, word ->
        val start = text.indexOf(word.text, cursor)
        if (start >= cursor && !text.substring(cursor, start).any { !it.isWhitespace() }) {
          if (start > cursor) runs += PresentationRun(text.substring(cursor, start), style, -1)
          runs += PresentationRun(word.text, word.style, index)
          cursor = start + word.text.length
        }
      }
      if (cursor < text.length) runs += PresentationRun(text.substring(cursor), style, -1)
      if (runs.isEmpty()) runs += PresentationRun(text, style, -1)
      runs.forEach { run ->
        val transformed = when (run.style.textTransform) {
          "uppercase" -> run.text.uppercase(java.util.Locale.ROOT)
          "lowercase" -> run.text.lowercase(java.util.Locale.ROOT)
          else -> run.text
        }
        transformed.split('\n').forEachIndexed { index, line ->
          if (index > 0) content.append('\n')
          if (line.isNotEmpty()) {
            if (line.isBlank()) { content.append(line) } else {
              // Replacement spans are bidi-neutral; retain each shaped run's strong direction.
              content.append(if (Bidi(line, Bidi.DIRECTION_DEFAULT_LEFT_TO_RIGHT).baseIsLeftToRight()) '\u200e' else '\u200f')
              val start = content.length
              content.append(line)
              content.setSpan(InkSpan(run.copy(text = line), paint(run.style), wordStates(run.style, run.timedIndex), dispatch),
                start, content.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
          }
        }
      }
      val basePaint = TextPaint(paint(style))
      val naturalWidth = max(1f, Layout.getDesiredWidth(content, basePaint) + 1f)
      val explicit = authored || text.contains('\n')
      val innerWidth = max(1f, boxWidth - style.backgroundPaddingX * 2f)
      fun layout(width: Float): StaticLayout {
        val builder = StaticLayout.Builder.obtain(content, 0, content.length, basePaint, ceil(width.toDouble()).toInt().coerceAtLeast(1))
          .setIncludePad(true)
          .setTextDirection(TextDirectionHeuristics.FIRSTSTRONG_LTR)
          .setAlignment(when (style.alignment) { "left" -> Layout.Alignment.ALIGN_NORMAL; "right" -> Layout.Alignment.ALIGN_OPPOSITE; else -> Layout.Alignment.ALIGN_CENTER })
          .setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
          .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
        if (Build.VERSION.SDK_INT >= 28) builder.setUseLineSpacingFromFallbacks(true)
        return builder.build()
      }
      var measured = layout(if (explicit) max(naturalWidth, innerWidth) else innerWidth)
      if (!explicit && measured.lineCount > style.maxLines) {
        var low = min(innerWidth, naturalWidth)
        var high = naturalWidth
        repeat(18) {
          val width = (low + high) / 2f
          val candidate = layout(width)
          if (candidate.lineCount <= style.maxLines) { high = width; measured = candidate } else low = width
        }
        measured = layout(high)
      }
      var lineLeft = 0f
      var lineRight = measured.width.toFloat()
      for (line in 0 until measured.lineCount) {
        lineLeft = min(lineLeft, measured.getLineLeft(line))
        lineRight = max(lineRight, measured.getLineRight(line))
      }
      val rectangle = RectF(lineLeft - measured.width / 2f - style.backgroundPaddingX,
        -measured.height / 2f - style.backgroundPaddingY,
        lineRight - measured.width / 2f + style.backgroundPaddingX,
        measured.height / 2f + style.backgroundPaddingY)
      val states = (0..512).map { step -> captionAnimationState(style.animationId, CaptionAnimationClock(min(1f, step / 128f), step / 128f), style.animationIntensity) }
      val bounds = animationBounds(rectangle, states)
      val ratio = min(1f, min(boxWidth / max(1f, bounds.width()), boxHeight / max(1f, bounds.height())))
      return TextPresentation(measured, ratio, bounds, text, dispatch)
    }
  }
}

private class InkSpan(
  private val run: PresentationRun,
  private val measure: Paint,
  states: List<TextAnimationState>,
  private val dispatch: TextPresentation.RunDispatch,
) : ReplacementSpan() {
  private val advance = measure.measureText(run.text)
  private val ink = Rect().also { measure.getTextBounds(run.text, 0, run.text.length, it) }
  private val metrics = measure.fontMetrics
  private val leading = max(0f, run.style.fontSize * run.style.lineHeight - (metrics.bottom - metrics.top)) / 2f
  private val shadow = if (run.style.shadowOpacity > 0f) run.style.shadowBlur * 3f + max(kotlin.math.abs(run.style.shadowOffsetX), kotlin.math.abs(run.style.shadowOffsetY)) else 0f
  private val treatment = when (run.style.textTreatment) { "duotone-neon" -> 34f; "duotone-shadow" -> 12f; "duotone-offset" -> 4f; else -> 0f }
  private val decoration = max(run.style.strokeWidth, max(shadow, treatment)) + if (run.style.animationId == "glow-pulse") 45f else 0f
  private val original = RectF(min(0f, ink.left.toFloat()) - decoration, min(metrics.top, ink.top.toFloat()) - leading - decoration,
    max(advance, ink.right.toFloat()) + decoration, max(metrics.bottom, ink.bottom.toFloat()) + leading + decoration)
  private val bounds = animationBounds(original, states)
  private val baselineCenter = (original.top + original.bottom) / 2f

  override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
    fm?.let {
      it.top = kotlin.math.floor(bounds.top.toDouble()).toInt()
      it.ascent = it.top
      it.bottom = ceil(bounds.bottom.toDouble()).toInt()
      it.descent = it.bottom
      it.leading = 0
    }
    return ceil(bounds.width().toDouble()).toInt()
  }

  override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
    dispatch.draw?.invoke(run, x - bounds.left, y.toFloat(), advance, baselineCenter)
  }
}

internal fun animationBounds(rectangle: RectF, states: List<TextAnimationState>): RectF {
  val result = RectF(rectangle)
  val cx = rectangle.centerX()
  val cy = rectangle.centerY()
  states.forEach { state ->
    val angle = state.rotation * Math.PI.toFloat() / 180f
    for (x in listOf(rectangle.left, rectangle.right)) for (y in listOf(rectangle.top, rectangle.bottom)) {
      val dx = (x - cx) * state.scaleX
      val dy = (y - cy) * state.scaleY
      val px = cx + state.translateX + dx * cos(angle) - dy * sin(angle)
      val py = cy + state.translateY + dx * sin(angle) + dy * cos(angle)
      result.left = min(result.left, px); result.right = max(result.right, px)
      result.top = min(result.top, py); result.bottom = max(result.bottom, py)
    }
  }
  // Cover sub-sample extrema and raster antialiasing without a font-size floor.
  val guard = max(1f, max(result.width(), result.height()) * 0.002f)
  result.inset(-guard, -guard)
  return result
}
