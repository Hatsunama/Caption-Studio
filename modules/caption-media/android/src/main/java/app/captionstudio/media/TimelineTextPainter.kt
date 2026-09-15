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
import java.util.LinkedHashMap
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
  private val emojiReactions by lazy { EmojiReactionCatalog(context) }
  private val typefaces = mutableMapOf<String, Typeface>()
  private data class LayoutKey(val text: String, val words: List<RenderWord>, val style: RenderTextStyle, val height: Float, val authored: Boolean)
  private val presentations = object : LinkedHashMap<LayoutKey, TextPresentation>(TEXT_PRESENTATION_CACHE_SIZE, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<LayoutKey, TextPresentation>?) = size > TEXT_PRESENTATION_CACHE_SIZE
  }

  fun prepare(styles: Iterable<RenderTextStyle>) { styles.filter { it.fontUri != null }.forEach(::typeface) }

  fun drawCaption(canvas: Canvas, caption: RenderCaption, timeMs: Long, outputWidth: Int, outputHeight: Int) {
    if (timeMs !in caption.startMs until caption.endMs) return
    drawText(canvas, caption, playbackTimedCaptionWords(caption), timeMs, outputWidth, outputHeight, false, false)
  }

  fun drawTextLayer(canvas: Canvas, layer: TextRenderLayer, timeMs: Long, outputWidth: Int, outputHeight: Int) {
    if (timeMs !in layer.startMs until layer.endMs) return
    drawText(canvas, RenderCaption(layer.id, layer.text, layer.startMs, layer.endMs, layer.style, emptyList()),
      emptyList(), timeMs, outputWidth, outputHeight, true, false)
  }

  fun drawPreview(canvas: Canvas, caption: RenderCaption, timeMs: Long, outputWidth: Int, outputHeight: Int, authored: Boolean, editing: Boolean) {
    drawText(canvas, caption, if (authored) emptyList() else playbackTimedCaptionWords(caption),
      timeMs, outputWidth, outputHeight, authored, editing)
  }

  internal fun presentationFor(caption: RenderCaption, words: List<RenderWord>, outputWidth: Int, outputHeight: Int, authored: Boolean): TextPresentation {
    val style = caption.style.copy(positionX = 0.5f, positionY = 0.5f, rotation = 0f, scale = 1f, scaleX = 1f, scaleY = 1f)
    val normalizedWords = words.map { it.copy(style = it.style.copy(positionX = 0.5f, positionY = 0.5f, rotation = 0f, scale = 1f, scaleX = 1f, scaleY = 1f)) }
    val height = style.boxHeight * DESIGN_WIDTH * outputHeight / outputWidth
    val key = LayoutKey(caption.text, normalizedWords, style, height, authored)
    presentations[key]?.let { return it }
    val fitted = TextPresentation.fit(caption.text, normalizedWords, style, style.boxWidth * DESIGN_WIDTH, height, authored,
      { paint(it, 1f, Paint.Style.FILL) },
      { wordStyle, index ->
        if (index < 0) emptyList() else (0..512).map { step ->
          wordAnimationState(wordStyle.animationId, true, step * 2L, RenderWord("", 0L, 1024L, wordStyle), index, wordStyle.animationIntensity, 1f)
        }
      })
    presentations[key] = fitted
    return fitted
  }

  private fun drawText(canvas: Canvas, caption: RenderCaption, words: List<RenderWord>, timeMs: Long,
    outputWidth: Int, outputHeight: Int, authored: Boolean, editing: Boolean) {
    val style = caption.style
    val fitted = presentationFor(caption, words, outputWidth, outputHeight, authored)
    val animation = if (editing) TextAnimationState() else captionAnimationState(style.animationId,
      captionAnimationClock(timeMs, caption.startMs, caption.endMs, style.animationDurationMs), style.animationIntensity)
    if (animation.alpha <= 0f) return
    canvas.save()
    canvas.translate(style.positionX * outputWidth, style.positionY * outputHeight)
    canvas.rotate(style.rotation)
    canvas.scale(style.scale * style.scaleX * outputWidth / DESIGN_WIDTH, style.scale * style.scaleY * outputWidth / DESIGN_WIDTH)
    canvas.scale(fitted.fit, fitted.fit)
    canvas.translate(-fitted.bounds.centerX(), -fitted.bounds.centerY())
    canvas.translate(animation.translateX, animation.translateY)
    canvas.rotate(animation.rotation)
    canvas.scale(animation.scaleX, animation.scaleY)
    if (style.backgroundOpacity > 0f) {
      val background = RectF(-fitted.layout.width / 2f - style.backgroundPaddingX, -fitted.layout.height / 2f - style.backgroundPaddingY,
        fitted.layout.width / 2f + style.backgroundPaddingX, fitted.layout.height / 2f + style.backgroundPaddingY)
      canvas.drawRoundRect(background, style.backgroundRadius, style.backgroundRadius, Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = colorWithOpacity(style.backgroundColor, style.backgroundOpacity * animation.alpha)
      })
    }
    canvas.save()
    canvas.translate(-fitted.layout.width / 2f, -fitted.layout.height / 2f)
    val activeIndex = words.indexOfFirst { timeMs in it.startMs until it.endMs }
    fitted.draw(canvas) { run, x, y, width, baselineCenter ->
      val index = run.timedIndex
      val timed = words.getOrNull(index)
      val active = index >= 0 && index == activeIndex
      val visible = editing || timed == null || when (style.animationId) {
        "single-word" -> active
        "typewriter" -> timed.startMs <= timeMs
        else -> true
      }
      if (visible) {
        val wordStyle = run.style
        val state = if (editing) TextAnimationState() else wordAnimationState(wordStyle.animationId, active, timeMs, timed, index, wordStyle.animationIntensity, 1f)
        val highlighted = !editing && ((active && style.animationId in ACTIVE_WORD_ANIMATIONS) ||
          (style.animationId == "karaoke" && activeIndex >= 0 && index in 0..activeIndex))
        canvas.save()
        canvas.translate(state.translateX, state.translateY)
        canvas.rotate(state.rotation, x + width / 2f, y + baselineCenter)
        canvas.scale(state.scaleX, state.scaleY, x + width / 2f, y + baselineCenter)
        drawWord(canvas, run.text, x, y, wordStyle, 1f, if (highlighted) wordStyle.activeWordColor else wordStyle.textColor,
          animation.alpha * state.alpha, !editing && style.animationId == "glow-pulse", animation.glow)
        canvas.restore()
      }
    }
    canvas.restore()
    if (!editing && style.animationId.startsWith("emoji-")) {
      captionCueProgress(timeMs, caption.startMs, caption.endMs)?.let { progress ->
        drawEmojiReaction(canvas, style.animationId, captionCueEmojis(emojiReactions, caption.text), 0f, 0f, progress, 1f)
      }
    }
    canvas.restore()
  }

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
    emojis: List<String>,
    centerX: Float,
    baselineY: Float,
    progress: Float,
    scaleFactor: Float,
  ) {
    if (emojis.isEmpty()) return
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 28f * scaleFactor; textAlign = Paint.Align.CENTER }
    emojis.forEachIndexed { index, emoji ->
      val angle = (index.toFloat() / emojis.size + if (id == "emoji-orbit") progress else 0f) * 2f * PI.toFloat()
      val radius = when (id) { "emoji-burst" -> progress * 90f * scaleFactor; "emoji-orbit" -> 55f * scaleFactor; else -> 80f * scaleFactor }
      val x = centerX + cos(angle) * radius
      val y = if (id == "emoji-rain") baselineY - (1f - progress) * 180f * scaleFactor + index * 26f * scaleFactor else baselineY + sin(angle) * radius
      paint.alpha = ((1f - progress * 0.65f) * 255).toInt().coerceIn(0, 255)
      canvas.drawText(emoji, x, y, paint)
    }
  }

  override fun close() { typefaces.clear(); presentations.clear() }

  private companion object {
    const val DESIGN_WIDTH = 360f
    const val TEXT_PRESENTATION_CACHE_SIZE = 48
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
