package app.captionstudio.media

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import java.io.File
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToLong
import kotlin.math.sin

internal data class CaptionAnimationClock(
  val entryProgress: Float,
  val phase: Float,
)

internal data class TextAnimationState(
  val translateX: Float = 0f,
  val translateY: Float = 0f,
  val scaleX: Float = 1f,
  val scaleY: Float = 1f,
  val rotation: Float = 0f,
  val alpha: Float = 1f,
  val glow: Float = 0f,
)

internal fun captionAnimationClock(
  currentMs: Long,
  captionStartMs: Long,
  captionEndMs: Long,
  animationDurationMs: Long,
): CaptionAnimationClock {
  val captionDurationMs = max(1L, captionEndMs - captionStartMs)
  val cycleDurationMs = max(1L, animationDurationMs)
  val entryDurationMs = min(captionDurationMs, cycleDurationMs)
  val elapsedMs = max(0L, currentMs - captionStartMs).toFloat()
  return CaptionAnimationClock(
    entryProgress = (elapsedMs / entryDurationMs).coerceIn(0f, 1f),
    phase = elapsedMs / cycleDurationMs,
  )
}

internal fun captionAnimationState(
  id: String,
  clock: CaptionAnimationClock,
  rawIntensity: Float,
): TextAnimationState {
  val entry = clock.entryProgress.coerceIn(0f, 1f)
  val phase = max(0f, clock.phase)
  val intensity = rawIntensity.coerceIn(0f, 1f)
  val eased = 1f - (1f - entry).pow(3)
  return when (id) {
    "fade-in" -> TextAnimationState(alpha = eased)
    "drop-in" -> TextAnimationState(alpha = entry, translateY = (1f - eased) * -(45f + intensity * 100f))
    "swing" -> TextAnimationState(alpha = entry, rotation = sin((1f - entry) * PI.toFloat() * 3f) * (10f + intensity * 30f))
    "heartbeat" -> {
      val beat = max(0f, sin(phase * PI.toFloat() * 4f)).pow(4)
      val scale = 1f + beat * (0.08f + intensity * 0.16f)
      TextAnimationState(scaleX = scale, scaleY = scale)
    }
    "flicker" -> TextAnimationState(alpha = if (entry < 0.9f && sin(entry * PI.toFloat() * 9f) <= -0.15f) 0.18f else 1f)
    "tilt-in" -> TextAnimationState(
      alpha = entry,
      translateX = (1f - eased) * (40f + intensity * 80f),
      rotation = (1f - eased) * (20f + intensity * 35f),
    )
    "squash" -> TextAnimationState(alpha = entry, scaleX = 0.55f + eased * 0.45f, scaleY = 1.55f - eased * 0.55f)
    "stretch" -> TextAnimationState(alpha = entry, scaleX = 1.45f - eased * 0.45f, scaleY = 0.35f + eased * 0.65f)
    "slide-up" -> TextAnimationState(alpha = entry, translateY = (1f - eased) * (35f + intensity * 80f))
    "slide-left" -> TextAnimationState(alpha = entry, translateX = (1f - eased) * -(55f + intensity * 120f))
    "slide-right" -> TextAnimationState(alpha = entry, translateX = (1f - eased) * (55f + intensity * 120f))
    "zoom-in" -> {
      val scale = 0.15f + eased * 0.85f
      TextAnimationState(alpha = entry, scaleX = scale, scaleY = scale)
    }
    "zoom-out" -> {
      val scale = 1f + (1f - eased) * (0.7f + intensity * 0.8f)
      TextAnimationState(alpha = entry, scaleX = scale, scaleY = scale)
    }
    "spin-in" -> {
      val scale = 0.5f + eased * 0.5f
      TextAnimationState(alpha = entry, rotation = (1f - eased) * -270f, scaleX = scale, scaleY = scale)
    }
    "roll-in" -> TextAnimationState(
      alpha = entry,
      translateX = (1f - eased) * -(70f + intensity * 130f),
      rotation = (1f - eased) * -(180f + intensity * 180f),
    )
    "spiral-in" -> {
      val radius = (1f - eased) * (45f + intensity * 75f)
      val angle = (1f - eased) * PI.toFloat() * 2f
      val scale = 0.25f + eased * 0.75f
      TextAnimationState(
        alpha = entry,
        translateX = cos(angle) * radius,
        translateY = sin(angle) * radius,
        rotation = (1f - eased) * 360f,
        scaleX = scale,
        scaleY = scale,
      )
    }
    "snap-in" -> {
      val wobble = sin(entry * PI.toFloat() * 3f) * (1f - entry)
      val scale = 1f + wobble * (0.16f + intensity * 0.18f)
      TextAnimationState(alpha = min(1f, entry * 3f), scaleX = scale, scaleY = scale)
    }
    "recoil" -> {
      val recoil = sin(entry * PI.toFloat() * 4f) * (1f - entry)
      TextAnimationState(
        alpha = min(1f, entry * 4f),
        translateX = -recoil * (12f + intensity * 32f),
        scaleX = 1f + recoil * (0.08f + intensity * 0.12f),
        scaleY = 1f - recoil * 0.06f,
        rotation = recoil * (4f + intensity * 8f),
      )
    }
    "shake" -> TextAnimationState(
      translateX = sin(phase * PI.toFloat() * 12f) * (4f + intensity * 16f),
      rotation = sin(phase * PI.toFloat() * 9f) * 2f,
    )
    "glow-pulse" -> {
      val pulse = sin(phase * PI.toFloat() * 2f)
      val scale = 1f + pulse * (0.02f + intensity * 0.06f)
      TextAnimationState(scaleX = scale, scaleY = scale, glow = abs(pulse))
    }
    "breathe" -> {
      val pulse = sin(phase * PI.toFloat() * 2f)
      val scale = 1f + pulse * (0.025f + intensity * 0.055f)
      TextAnimationState(scaleX = scale, scaleY = scale)
    }
    "float" -> {
      val angle = phase * PI.toFloat() * 2f
      TextAnimationState(
        translateX = cos(angle) * (2f + intensity * 6f),
        translateY = sin(angle) * (4f + intensity * 10f),
      )
    }
    "wobble" -> TextAnimationState(rotation = sin(phase * PI.toFloat() * 2f) * (2f + intensity * 9f))
    "drift" -> TextAnimationState(
      translateX = sin(phase * PI.toFloat() * 2f) * (4f + intensity * 14f),
      translateY = cos(phase * PI.toFloat() * 1.5f) * (3f + intensity * 8f),
    )
    "pulse" -> {
      val beat = abs(sin(phase * PI.toFloat() * 2f))
      val scale = 1f + beat * (0.04f + intensity * 0.1f)
      TextAnimationState(scaleX = scale, scaleY = scale)
    }
    "elastic" -> {
      val wobble = sin(entry * PI.toFloat() * 5f) * (1f - entry)
      TextAnimationState(
        alpha = min(1f, entry * 2.5f),
        scaleX = 1f + wobble * (0.35f + intensity),
        scaleY = 1f - wobble * 0.18f,
      )
    }
    "flip" -> TextAnimationState(
      alpha = entry,
      scaleX = max(0.03f, abs(cos((1f - eased) * 95f * PI.toFloat() / 180f))),
    )
    "stomp" -> {
      val scale = 1f + sin(entry * PI.toFloat()) * intensity * 0.35f
      TextAnimationState(
        alpha = entry,
        translateY = (1f - eased) * -(50f + intensity * 100f),
        scaleX = scale,
        scaleY = scale,
      )
    }
    "lean-in" -> TextAnimationState(
      alpha = entry,
      translateX = (1f - eased) * -(35f + intensity * 85f),
      rotation = (1f - eased) * -(12f + intensity * 24f),
    )
    "rise-spin" -> TextAnimationState(
      alpha = entry,
      translateY = (1f - eased) * (45f + intensity * 90f),
      rotation = (1f - eased) * (110f + intensity * 170f),
    )
    "soft-land" -> {
      val landing = sin(entry * PI.toFloat() * 2f) * (1f - entry)
      TextAnimationState(
        alpha = entry,
        translateY = (1f - eased) * (24f + intensity * 50f) - landing * (8f + intensity * 14f),
        scaleX = 1f + landing * 0.04f,
        scaleY = 1f - landing * (0.05f + intensity * 0.08f),
      )
    }
    "rubber-drop" -> {
      val spring = sin(entry * PI.toFloat() * 4f) * (1f - entry)
      TextAnimationState(
        alpha = min(1f, entry * 3f),
        translateY = (1f - eased) * -(60f + intensity * 120f),
        scaleX = 1f + spring * (0.16f + intensity * 0.18f),
        scaleY = 1f - spring * (0.12f + intensity * 0.12f),
      )
    }
    "cinema-fade" -> {
      val scale = 0.92f + eased * 0.08f
      TextAnimationState(
        alpha = eased,
        translateY = (1f - eased) * (10f + intensity * 18f),
        scaleX = scale,
        scaleY = scale,
      )
    }
    else -> TextAnimationState()
  }
}

internal fun realTimedCaptionWords(caption: RenderCaption): List<RenderWord> {
  if (caption.words.isEmpty() || caption.words.any { it.endMs <= it.startMs }) return emptyList()
  val captionUnits = CaptionTextBreaks.timingUnits(caption.text)
  val timedUnits = caption.words.flatMap(::expandTimedWord)
  if (
    captionUnits.isEmpty()
    || captionUnits.size != timedUnits.size
    || captionUnits.indices.any { captionUnits[it].key != timedUnits[it].key }
  ) return emptyList()
  return captionUnits.indices.map { index ->
    timedUnits[index].word.copy(
      text = captionUnits[index].text,
      startMs = timedUnits[index].startMs,
      endMs = timedUnits[index].endMs,
    )
  }
}

private data class ExpandedTimedWord(
  val key: String,
  val word: RenderWord,
  val startMs: Long,
  val endMs: Long,
)

private fun expandTimedWord(word: RenderWord): List<ExpandedTimedWord> {
  val units = CaptionTextBreaks.timingUnits(word.text)
  if (units.isEmpty()) return emptyList()
  val weights = units.map { max(1, CaptionTextBreaks.graphemeCount(it.text)) }
  val totalWeight = weights.sum()
  val durationMs = word.endMs - word.startMs
  var consumedWeight = 0
  return units.mapIndexedNotNull { index, unit ->
    val startMs = word.startMs + (durationMs.toDouble() * consumedWeight / totalWeight).roundToLong()
    consumedWeight += weights[index]
    val endMs = word.startMs + (durationMs.toDouble() * consumedWeight / totalWeight).roundToLong()
    if (endMs <= startMs) null else ExpandedTimedWord(unit.key, word, startMs, endMs)
  }
}

internal fun playbackTimedCaptionWords(caption: RenderCaption): List<RenderWord> {
  val aligned = realTimedCaptionWords(caption)
  if (aligned.isNotEmpty()) return aligned
  return CaptionTextBreaks.spreadTokens(caption.text, caption.startMs, caption.endMs).map { token ->
    RenderWord(token.text, token.startMs, token.endMs, caption.style)
  }
}

internal class TimelineTextPainter(private val context: Context) : AutoCloseable {
  private val emojiReactions = EmojiReactionCatalog(context)
  private val typefaces = mutableMapOf<String, Typeface>()

  fun prepare(styles: Iterable<RenderTextStyle>) {
    styles.filter { it.fontUri != null }.forEach(::typeface)
  }

  fun drawCaption(canvas: Canvas, caption: RenderCaption, timeMs: Long, outputWidth: Int, outputHeight: Int) {
    if (timeMs !in caption.startMs until caption.endMs) return
    val tokens = playbackTimedCaptionWords(caption)
    drawText(canvas, caption.text, tokens, caption.style, caption.startMs, caption.endMs, timeMs, outputWidth, outputHeight)
  }

  fun drawTextLayer(canvas: Canvas, layer: TextRenderLayer, timeMs: Long, outputWidth: Int, outputHeight: Int) {
    if (timeMs !in layer.startMs until layer.endMs) return
    drawText(canvas, layer.text, emptyList(), layer.style, layer.startMs, layer.endMs, timeMs, outputWidth, outputHeight)
  }

  private fun drawText(
    canvas: Canvas,
    text: String,
    timedWords: List<RenderWord>,
    style: RenderTextStyle,
    startMs: Long,
    endMs: Long,
    timeMs: Long,
    outputWidth: Int,
    outputHeight: Int,
  ) {
    val transformedText = transformText(text, style.textTransform)
    val fitted = fitLayout(transformedText, timedWords, style, outputWidth, outputHeight)
    val words = fitted.words
    if (words.isEmpty()) return
    val animation = captionAnimationState(
      style.animationId,
      captionAnimationClock(timeMs, startMs, endMs, style.animationDurationMs),
      style.animationIntensity,
    )
    if (animation.alpha <= 0f) return
    val centerX = style.positionX * outputWidth
    val centerY = style.positionY * outputHeight
    val scaleFactor = fitted.scaleFactor
    val boxWidth = style.boxWidth * outputWidth
    val boxHeight = style.boxHeight * outputHeight
    val box = RectF(centerX - boxWidth / 2f, centerY - boxHeight / 2f, centerX + boxWidth / 2f, centerY + boxHeight / 2f)
    val lineHeight = fitted.lineHeight
    val contentHeight = words.maxOf { it.line } * lineHeight + lineHeight
    val baseY = centerY - contentHeight / 2f + fitted.ascent

    canvas.save()
    val animationScale = outputWidth / DESIGN_WIDTH
    canvas.translate(animation.translateX * animationScale, animation.translateY * animationScale)
    canvas.rotate(style.rotation + animation.rotation, centerX, centerY)
    canvas.scale(animation.scaleX, animation.scaleY, centerX, centerY)
    if (style.backgroundOpacity > 0f) {
      val backgroundPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = colorWithOpacity(style.backgroundColor, style.backgroundOpacity * animation.alpha)
      }
      val paddingX = style.backgroundPaddingX * scaleFactor
      val paddingY = style.backgroundPaddingY * scaleFactor
      val content = RectF(
        max(box.left, words.minOf { it.x } - paddingX),
        centerY - contentHeight / 2f - paddingY,
        min(box.right, words.maxOf { it.x + it.width } + paddingX),
        centerY + contentHeight / 2f + paddingY,
      )
      canvas.drawRoundRect(content, style.backgroundRadius * scaleFactor, style.backgroundRadius * scaleFactor, backgroundPaint)
    }

    val activeIndex = timedWords.indexOfFirst { timeMs in it.startMs until it.endMs }
    val visibleTimedWords = when (style.animationId) {
      "single-word" -> setOf(activeIndex)
      "typewriter" -> timedWords.indices.filterTo(mutableSetOf()) { index -> timedWords[index].startMs <= timeMs }
      else -> timedWords.indices.toSet()
    }
    currentLineWords = words
    words.forEachIndexed { _, word ->
      val timedIndex = word.timedIndex
      if (timedIndex >= 0 && timedIndex !in visibleTimedWords) return@forEachIndexed
      val wordStyle = word.style
      val isActive = timedIndex == activeIndex
      val isKaraokeActive = style.animationId == "karaoke" && activeIndex >= 0 && timedIndex in 0..activeIndex
      val wordState = wordAnimationState(
        wordStyle.animationId,
        isActive,
        timeMs,
        timedWords.getOrNull(timedIndex),
        timedIndex,
        wordStyle.animationIntensity,
        scaleFactor,
      )
      canvas.save()
      val x = alignedX(word, box, style.alignment)
      val y = baseY + word.line * lineHeight
      canvas.translate(wordState.translateX, wordState.translateY)
      canvas.rotate(wordState.rotation, x + word.width / 2f, y)
      canvas.scale(wordState.scaleX, wordState.scaleY, x + word.width / 2f, y)
      val alpha = animation.alpha * wordState.alpha
      val fillColor = if ((isActive && style.animationId in ACTIVE_WORD_ANIMATIONS) || isKaraokeActive) wordStyle.activeWordColor else wordStyle.textColor
      drawWord(
        canvas,
        word.text,
        x,
        y,
        wordStyle,
        scaleFactor,
        fillColor,
        alpha,
        style.animationId == "glow-pulse",
        animation.glow,
      )
      canvas.restore()
      if (style.animationId.startsWith("emoji-") && isActive) {
        drawEmojiReaction(
          canvas = canvas,
          id = style.animationId,
          word = word.text,
          captionText = text,
          contextWords = timedWords.map(RenderWord::text),
          activeIndex = timedIndex,
          centerX = x + word.width / 2f,
          baselineY = y,
          timeMs = timeMs,
          timing = timedWords[timedIndex],
          scaleFactor = scaleFactor,
        )
      }
    }
    currentLineWords = null
    canvas.restore()
  }

  private fun fitLayout(
    text: String,
    timedWords: List<RenderWord>,
    style: RenderTextStyle,
    outputWidth: Int,
    outputHeight: Int,
  ): FittedLayout {
    val baseScale = outputWidth / DESIGN_WIDTH
    val boxHeight = style.boxHeight * outputHeight
    val availableHeight = max(1f, boxHeight - style.backgroundPaddingY * baseScale * 2f)
    var low = 0.001f
    var high = 1f
    var best = layoutWords(text, timedWords, style, baseScale * low, outputWidth)
    var bestRatio = low
    repeat(14) {
      val ratio = (low + high) / 2f
      val scale = baseScale * ratio
      val candidate = layoutWords(text, timedWords, style, scale, outputWidth)
      val lineHeight = layoutLineHeight(candidate.words, scale, style)
      val fits = candidate.lineCount <= style.maxLines &&
        candidate.lineCount * lineHeight <= availableHeight &&
        candidate.widestWord <= style.boxWidth * outputWidth
      if (fits) {
        low = ratio
        best = candidate
        bestRatio = ratio
      } else {
        high = ratio
      }
    }
    val scaleFactor = baseScale * bestRatio
    return FittedLayout(
      best.words,
      scaleFactor,
      layoutLineHeight(best.words, scaleFactor, style),
      layoutAscent(best.words, scaleFactor, style),
    )
  }

  private fun layoutLineHeight(words: List<PositionedWord>, scaleFactor: Float, fallback: RenderTextStyle) =
    words.maxOfOrNull { it.style.fontSize * scaleFactor * it.style.lineHeight }
      ?: fallback.fontSize * scaleFactor * fallback.lineHeight

  private fun layoutAscent(words: List<PositionedWord>, scaleFactor: Float, fallback: RenderTextStyle) =
    words.maxOfOrNull { -paint(it.style, scaleFactor, Paint.Style.FILL).fontMetrics.ascent }
      ?: -paint(fallback, scaleFactor, Paint.Style.FILL).fontMetrics.ascent

  private fun layoutWords(
    text: String,
    timedWords: List<RenderWord>,
    style: RenderTextStyle,
    scaleFactor: Float,
    outputWidth: Int,
  ): WordLayout {
    val rawWords = if (timedWords.isEmpty()) CaptionTextBreaks.tokens(text) else timedWords.map(RenderWord::text)
    if (rawWords.isEmpty()) return WordLayout(emptyList(), 0, 0f)
    val maxWidth = style.boxWidth * outputWidth
    val result = mutableListOf<PositionedWord>()
    var line = 0
    var x = style.positionX * outputWidth - maxWidth / 2f
    val lineStart = x
    var widestWord = 0f
    rawWords.forEachIndexed { index, token ->
      val timed = timedWords.getOrNull(index)
      val tokenStyle = timed?.style ?: style
      val wordText = transformText(token, tokenStyle.textTransform)
      val measurePaint = paint(tokenStyle, scaleFactor, Paint.Style.FILL)
      val width = measurePaint.measureText(wordText)
      widestWord = max(widestWord, width)
      val nextToken = rawWords.getOrNull(index + 1)
      val space = if (CaptionTextBreaks.usesCompactSpacing(token) || nextToken?.let(CaptionTextBreaks::usesCompactSpacing) == true) {
        0f
      } else {
        measurePaint.measureText(" ")
      }
      if (x > lineStart && x + width > lineStart + maxWidth) {
        line += 1
        x = lineStart
      }
      result += PositionedWord(wordText, x, width, line, timed?.let { index } ?: -1, tokenStyle)
      x += width + space
    }
    return WordLayout(result, line + 1, widestWord)
  }

  private fun alignedX(word: PositionedWord, box: RectF, alignment: String): Float {
    if (alignment == "left") return word.x
    val lineWords = currentLineWords ?: return word.x
    val onLine = lineWords.filter { it.line == word.line }
    val left = onLine.minOfOrNull { it.x } ?: word.x
    val right = onLine.maxOfOrNull { it.x + it.width } ?: (word.x + word.width)
    val offset = when (alignment) {
      "right" -> box.right - right
      else -> box.centerX() - (left + right) / 2f
    }
    return word.x + offset
  }

  private var currentLineWords: List<PositionedWord>? = null

  private fun drawWord(
    canvas: Canvas,
    text: String,
    x: Float,
    y: Float,
    style: RenderTextStyle,
    scaleFactor: Float,
    fillColor: String,
    alpha: Float,
    captionGlowEnabled: Boolean,
    captionGlow: Float,
  ) {
    if (style.textTreatment != "solid") {
      val secondary = paint(style, scaleFactor, Paint.Style.FILL).apply {
        color = colorWithOpacity(style.secondaryTextColor, alpha)
        when (style.textTreatment) {
          "duotone-neon" -> setShadowLayer(10f * scaleFactor, 0f, 0f, color)
          "duotone-shadow" -> setShadowLayer(2f * scaleFactor, 0f, 4f * scaleFactor, color)
        }
      }
      val offset = if (style.textTreatment == "duotone-offset") 4f * scaleFactor else 2f * scaleFactor
      canvas.drawText(text, x + offset, y + offset, secondary)
    }
    if (style.strokeWidth > 0f) {
      val stroke = paint(style, scaleFactor, Paint.Style.STROKE).apply {
        color = colorWithOpacity(style.strokeColor, alpha)
        strokeWidth = style.strokeWidth * scaleFactor * 2f
        strokeJoin = Paint.Join.ROUND
      }
      canvas.drawText(text, x, y, stroke)
    }
    val fill = paint(style, scaleFactor, Paint.Style.FILL).apply {
      color = colorWithOpacity(fillColor, alpha)
      if (captionGlowEnabled) {
        setShadowLayer(
          (7f + 8f * captionGlow) * scaleFactor,
          style.shadowOffsetX * scaleFactor,
          style.shadowOffsetY * scaleFactor,
          colorWithOpacity(style.activeWordColor, alpha),
        )
      } else if (style.shadowOpacity > 0f) {
        setShadowLayer(
          style.shadowBlur * scaleFactor,
          style.shadowOffsetX * scaleFactor,
          style.shadowOffsetY * scaleFactor,
          colorWithOpacity(style.shadowColor, style.shadowOpacity * alpha),
        )
      }
    }
    canvas.drawText(text, x, y, fill)
  }

  private fun paint(style: RenderTextStyle, scaleFactor: Float, paintStyle: Paint.Style) = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply {
    typeface = typeface(style)
    textSize = style.fontSize * scaleFactor
    letterSpacing = style.letterSpacing / max(1f, style.fontSize)
    this.style = paintStyle
  }

  private fun typeface(style: RenderTextStyle): Typeface {
    val key = "${style.fontUri}|${style.fontFamily}|${style.fontWeight}|${style.italic}"
    return typefaces.getOrPut(key) {
      val base = style.fontUri?.let(::loadTypeface)
        ?: Typeface.create(style.fontFamily, Typeface.NORMAL)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        Typeface.create(base, style.fontWeight, style.italic)
      } else {
        Typeface.create(base, (if (style.fontWeight >= 700) Typeface.BOLD else Typeface.NORMAL) or (if (style.italic) Typeface.ITALIC else 0))
      }
    }
  }

  private fun loadTypeface(uri: String): Typeface {
    try {
      val parsed = Uri.parse(uri)
      return if (parsed.scheme.isNullOrEmpty() || parsed.scheme == "file") {
        val file = File(parsed.path ?: uri)
        require(file.isFile && file.canRead()) { "The resolved font file is unavailable" }
        Typeface.createFromFile(file)
      } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.contentResolver.openFileDescriptor(parsed, "r")?.use { descriptor ->
          Typeface.Builder(descriptor.fileDescriptor).build()
        } ?: throw IllegalArgumentException("The resolved font URI is unavailable")
      } else {
        val temporary = File.createTempFile("caption-font-", ".font", context.cacheDir)
        try {
          context.contentResolver.openInputStream(parsed)?.use { source ->
            temporary.outputStream().use(source::copyTo)
          } ?: throw IllegalArgumentException("The resolved font URI is unavailable")
          require(temporary.length() > 0) { "The resolved font URI is empty" }
          Typeface.createFromFile(temporary)
        } finally {
          temporary.delete()
        }
      }
    } catch (error: Exception) {
      throw IllegalArgumentException("A resolved font could not be opened or decoded", error)
    }
  }

  private fun wordAnimationState(
    id: String,
    active: Boolean,
    timeMs: Long,
    word: RenderWord?,
    index: Int,
    intensity: Float,
    scaleFactor: Float,
  ): TextAnimationState {
    if (!active || word == null || timeMs !in word.startMs until word.endMs) return TextAnimationState()
    val progress = ((timeMs - word.startMs).toFloat() / max(1L, word.endMs - word.startMs)).coerceIn(0f, 1f)
    val pulse = sin(progress * PI.toFloat())
    val eased = 1f - (1f - progress).pow(3)
    return when (id) {
      "wave" -> TextAnimationState(translateY = sin(progress * PI.toFloat() * 2f + max(0, index) * 0.85f) * (4f + intensity * 18f) * scaleFactor)
      "pop" -> {
        val scale = 0.65f + pulse * (0.5f + intensity)
        TextAnimationState(scaleX = scale, scaleY = scale, rotation = (1f - pulse) * -5f)
      }
      "bounce" -> TextAnimationState(translateY = -abs(sin(progress * PI.toFloat() * 2f)) * (8f + intensity * 32f) * scaleFactor)
      "punch" -> {
        val scale = 1f + pulse * (0.3f + intensity * 0.7f)
        TextAnimationState(scaleX = scale, scaleY = scale, rotation = sin(progress * PI.toFloat() * 2f) * 3f)
      }
      "word-spin" -> {
        val scale = 0.7f + pulse * 0.55f
        TextAnimationState(rotation = (1f - pulse) * -180f, scaleX = scale, scaleY = scale)
      }
      "word-slide" -> TextAnimationState(
        translateX = (1f - pulse) * -(24f + intensity * 70f) * scaleFactor,
        alpha = min(1f, pulse * 2f),
      )
      "word-flash" -> {
        val scale = 1f + pulse * (0.12f + intensity * 0.2f)
        TextAnimationState(scaleX = scale, scaleY = scale, alpha = 0.45f + pulse * 0.55f)
      }
      "word-jitter" -> TextAnimationState(
        translateX = sin(progress * PI.toFloat() * 18f) * (2f + intensity * 8f) * scaleFactor,
        translateY = cos(progress * PI.toFloat() * 14f) * (1f + intensity * 5f) * scaleFactor,
      )
      "word-rise" -> TextAnimationState(alpha = eased, translateY = (1f - eased) * (20f + intensity * 44f) * scaleFactor)
      "word-drop" -> TextAnimationState(alpha = eased, translateY = (1f - eased) * -(20f + intensity * 44f) * scaleFactor)
      "word-zoom" -> {
        val scale = 0.35f + eased * 0.65f
        TextAnimationState(alpha = eased, scaleX = scale, scaleY = scale)
      }
      "word-tilt" -> TextAnimationState(
        alpha = eased,
        translateX = (1f - eased) * (18f + intensity * 40f) * scaleFactor,
        rotation = (1f - eased) * (18f + intensity * 24f),
      )
      "word-wobble" -> TextAnimationState(rotation = sin(progress * PI.toFloat() * 6f) * (1f - progress) * (5f + intensity * 14f))
      "word-squash" -> TextAnimationState(
        alpha = eased,
        scaleX = 0.55f + eased * 0.45f,
        scaleY = 1.5f - eased * 0.5f,
      )
      "word-stretch" -> TextAnimationState(
        alpha = eased,
        scaleX = 1.4f - eased * 0.4f,
        scaleY = 0.45f + eased * 0.55f,
      )
      "word-fade" -> TextAnimationState(alpha = eased)
      "word-drift" -> TextAnimationState(
        alpha = eased,
        translateX = (1f - eased) * -(18f + intensity * 50f) * scaleFactor,
        translateY = pulse * (3f + intensity * 8f) * scaleFactor,
      )
      "word-kick" -> TextAnimationState(
        translateY = -pulse * (8f + intensity * 28f) * scaleFactor,
        rotation = sin(progress * PI.toFloat() * 2f) * (3f + intensity * 8f),
      )
      "word-breathe" -> {
        val scale = 1f + pulse * (0.04f + intensity * 0.12f)
        TextAnimationState(scaleX = scale, scaleY = scale)
      }
      else -> TextAnimationState()
    }
  }

  private fun drawEmojiReaction(
    canvas: Canvas,
    id: String,
    word: String,
    captionText: String,
    contextWords: List<String>,
    activeIndex: Int,
    centerX: Float,
    baselineY: Float,
    timeMs: Long,
    timing: RenderWord,
    scaleFactor: Float,
  ) {
    val emojis = emojiReactions.resolve(word, captionText, contextWords, activeIndex)
    if (emojis.isEmpty()) return
    val progress = ((timeMs - timing.startMs).toFloat() / max(1L, timing.endMs - timing.startMs)).coerceIn(0f, 1f)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 28f * scaleFactor; textAlign = Paint.Align.CENTER }
    repeat(when (id) { "emoji-rain" -> 5; "emoji-orbit" -> 4; else -> 6 }) { index ->
      val angle = index / 6f * 2f * PI.toFloat() + progress * if (id == "emoji-orbit") 5f else 1f
      val radius = when (id) { "emoji-burst" -> progress * 90f * scaleFactor; "emoji-orbit" -> 55f * scaleFactor; else -> 80f * scaleFactor }
      val x = centerX + cos(angle) * radius
      val y = if (id == "emoji-rain") baselineY - (1f - progress) * 180f * scaleFactor + index * 26f * scaleFactor else baselineY + sin(angle) * radius
      paint.alpha = ((1f - progress * 0.65f) * 255).toInt().coerceIn(0, 255)
      canvas.drawText(emojis[index % emojis.size], x, y, paint)
    }
  }

  override fun close() {
    typefaces.clear()
  }

  private data class FittedLayout(
    val words: List<PositionedWord>,
    val scaleFactor: Float,
    val lineHeight: Float,
    val ascent: Float,
  )

  private data class WordLayout(val words: List<PositionedWord>, val lineCount: Int, val widestWord: Float)

  private data class PositionedWord(
    val text: String,
    val x: Float,
    val width: Float,
    val line: Int,
    val timedIndex: Int,
    val style: RenderTextStyle,
  )

  private companion object {
    const val DESIGN_WIDTH = 360f
    val ACTIVE_WORD_ANIMATIONS = setOf("active-word", "karaoke", "word-flash")
  }
}

private fun transformText(value: String, transform: String) = when (transform) {
  "uppercase" -> value.uppercase()
  "lowercase" -> value.lowercase()
  else -> value
}

private fun colorWithOpacity(value: String, opacity: Float): Int {
  val color = Color.parseColor(value)
  val alpha = (Color.alpha(color) * opacity.coerceIn(0f, 1f)).toInt().coerceIn(0, 255)
  return Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color))
}
