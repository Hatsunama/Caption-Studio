package app.captionstudio.media

import java.util.Locale

internal data class TimelineRenderPlan(
  val durationMs: Long,
  val width: Int,
  val height: Int,
  val frameRate: Int,
  val backgroundColor: String,
  val burnCaptions: Boolean,
  val videoTransform: VideoTransform,
  val clips: List<RenderVideoClip>,
  val backgroundReplacement: RenderBackgroundReplacement?,
  val captions: List<RenderCaption>,
  val layers: List<RenderLayer>,
  val audioClips: List<RenderAudioClip>,
)

internal data class VideoTransform(
  val fit: String,
  val positionX: Float,
  val positionY: Float,
  val scale: Float,
  val rotation: Float,
)

internal data class RenderVideoClip(
  val id: String,
  val uri: String,
  val timelineStartMs: Long,
  val timelineEndMs: Long,
  val availableSourceStartMs: Long,
  val availableSourceEndMs: Long,
  val sourceStartMs: Long,
  val sourceEndMs: Long,
  val playbackRate: Float,
  val volume: Float,
  val muted: Boolean,
  val fadeInMs: Long,
  val fadeOutMs: Long,
  val transitionType: String,
  val transitionDurationMs: Long,
  val transform: VideoTransform,
) {
  val timelineDurationMs get() = timelineEndMs - timelineStartMs
}

internal data class RenderBackgroundReplacement(
  val kind: String,
  val uri: String,
  val settings: PersonMatteSettings,
  val transform: PersonTransformFrame,
  val keyframes: List<PersonTransformFrame>,
)

internal data class RenderCaption(
  val id: String,
  val text: String,
  val startMs: Long,
  val endMs: Long,
  val style: RenderTextStyle,
  val words: List<RenderWord>,
)

internal data class RenderWord(
  val text: String,
  val startMs: Long,
  val endMs: Long,
  val style: RenderTextStyle,
)

internal data class RenderTextStyle(
  val fontSource: String,
  val fontFamily: String,
  val fontUri: String?,
  val fontSize: Float,
  val fontWeight: Int,
  val italic: Boolean,
  val textColor: String,
  val secondaryTextColor: String,
  val textTreatment: String,
  val activeWordColor: String,
  val strokeColor: String,
  val strokeWidth: Float,
  val shadowColor: String,
  val shadowOpacity: Float,
  val shadowBlur: Float,
  val shadowOffsetX: Float,
  val shadowOffsetY: Float,
  val backgroundColor: String,
  val backgroundOpacity: Float,
  val backgroundRadius: Float,
  val backgroundPaddingX: Float,
  val backgroundPaddingY: Float,
  val alignment: String,
  val letterSpacing: Float,
  val lineHeight: Float,
  val textTransform: String,
  val positionX: Float,
  val positionY: Float,
  val boxWidth: Float,
  val boxHeight: Float,
  val rotation: Float,
  val maxLines: Int,
  val animationId: String,
  val animationIntensity: Float,
  val animationDurationMs: Long,
)

internal sealed interface RenderLayer {
  val id: String
  val visible: Boolean
}

internal data class CaptionRenderLayer(
  override val id: String,
  override val visible: Boolean,
) : RenderLayer

internal data class TextRenderLayer(
  override val id: String,
  override val visible: Boolean,
  val text: String,
  val startMs: Long,
  val endMs: Long,
  val style: RenderTextStyle,
) : RenderLayer

internal data class ImageRenderLayer(
  override val id: String,
  override val visible: Boolean,
  val uri: String,
  val startMs: Long,
  val endMs: Long,
  val positionX: Float,
  val positionY: Float,
  val boxWidth: Float,
  val boxHeight: Float,
  val rotation: Float,
  val opacity: Float,
) : RenderLayer

internal data class RenderAudioClip(
  val id: String,
  val uri: String,
  val startMs: Long,
  val sourceStartMs: Long,
  val sourceEndMs: Long,
  val volume: Float,
  val muted: Boolean,
  val fadeInMs: Long,
  val fadeOutMs: Long,
)

internal fun parseTimelineRenderPlan(value: Map<String, Any>): TimelineRenderPlan {
  require(value.number("version").toInt() == 1) { "Unsupported render plan version" }
  val durationMs = value.number("durationMs").toLong()
  val width = value.number("width").toInt()
  val height = value.number("height").toInt()
  require(durationMs > 0 && width in 2..3840 && height in 2..3840) { "The render plan dimensions or duration are invalid" }
  require(width % 2 == 0 && height % 2 == 0) { "Export dimensions must be even" }
  val videoTransform = parseVideoTransform(value.map("videoTransform"))
  return TimelineRenderPlan(
    durationMs = durationMs,
    width = width,
    height = height,
    frameRate = value.numberOr("frameRate", 30).toInt().coerceIn(15, 60),
    backgroundColor = value.colorOr("backgroundColor", "#000000", "backgroundColor"),
    burnCaptions = value.booleanOr("burnCaptions", true),
    videoTransform = videoTransform,
    clips = value.list("clips").map { parseVideoClip(it, videoTransform) },
    backgroundReplacement = value.optionalMap("backgroundReplacement")?.let(::parseBackgroundReplacement),
    captions = value.list("captions").map(::parseCaption),
    layers = value.list("layers").map(::parseLayer),
    audioClips = value.list("audioClips").map(::parseAudioClip),
  ).also { plan ->
    require(plan.clips.isNotEmpty()) { "The render plan does not contain video clips" }
    require(plan.clips.zipWithNext().all { (first, second) -> first.timelineEndMs <= second.timelineStartMs }) {
      "Video clips must be ordered and non-overlapping"
    }
    require(plan.clips.all { it.timelineEndMs <= plan.durationMs }) { "A video clip extends beyond the render duration" }
    require(plan.captions.all { it.startMs >= 0 && it.endMs > it.startMs && it.endMs <= plan.durationMs }) {
      "A caption has invalid timeline bounds"
    }
    require(plan.audioClips.all { it.startMs >= 0 && it.startMs < plan.durationMs }) {
      "An audio clip starts outside the render duration"
    }
  }
}

private fun parseVideoClip(value: Map<String, Any>, defaultTransform: VideoTransform): RenderVideoClip {
  val transition = value.map("transition")
  return RenderVideoClip(
    id = value.string("id"),
    uri = value.string("uri"),
    timelineStartMs = value.number("timelineStartMs").toLong(),
    timelineEndMs = value.number("timelineEndMs").toLong(),
    availableSourceStartMs = value.numberOr("availableSourceStartMs", 0).toLong(),
    availableSourceEndMs = value.optionalNumber("availableSourceEndMs")?.toLong() ?: Long.MAX_VALUE,
    sourceStartMs = value.number("sourceStartMs").toLong(),
    sourceEndMs = value.number("sourceEndMs").toLong(),
    playbackRate = value.numberOr("playbackRate", 1).toFloat().coerceIn(0.1f, 8f),
    volume = value.numberOr("volume", 1).toFloat().coerceIn(0f, 1f),
    muted = value.booleanOr("muted", false),
    fadeInMs = value.numberOr("fadeInMs", 0).toLong().coerceAtLeast(0),
    fadeOutMs = value.numberOr("fadeOutMs", 0).toLong().coerceAtLeast(0),
    transitionType = TimelineTransitionSpec.requireSupported(transition.stringOr("type", "none")),
    transitionDurationMs = transition.numberOr("durationMs", 0).toLong().coerceAtLeast(0),
    transform = value.optionalMap("transform")?.let(::parseVideoTransform) ?: defaultTransform,
  ).also { clip ->
    require(clip.timelineStartMs >= 0 && clip.timelineEndMs > clip.timelineStartMs) { "Clip ${clip.id} has invalid timeline bounds" }
    require(clip.sourceStartMs >= 0 && clip.sourceEndMs > clip.sourceStartMs) { "Clip ${clip.id} has invalid source bounds" }
    require(
      clip.availableSourceStartMs >= 0 &&
        clip.availableSourceStartMs <= clip.sourceStartMs &&
        clip.availableSourceEndMs >= clip.sourceEndMs,
    ) { "Clip ${clip.id} has invalid recoverable source bounds" }
    require(clip.transitionDurationMs <= 2_000) { "Clip ${clip.id} transition duration is invalid" }
  }
}

private fun parseVideoTransform(value: Map<String, Any>): VideoTransform {
  val fit = value.stringOr("fit", "fit")
  require(fit == "fit" || fit == "fill") { "Unsupported video fit '$fit'" }
  val position = value.map("position")
  return VideoTransform(
    fit = fit,
    positionX = position.numberOr("x", 0.5).toFloat().also {
      require(it in 0f..1f) { "Video position x must be between 0 and 1" }
    },
    positionY = position.numberOr("y", 0.5).toFloat().also {
      require(it in 0f..1f) { "Video position y must be between 0 and 1" }
    },
    scale = value.numberOr("scale", 1).toFloat().coerceIn(0.05f, 12f),
    rotation = value.numberOr("rotation", 0).toFloat(),
  )
}

private fun parseBackgroundReplacement(value: Map<String, Any>): RenderBackgroundReplacement {
  val transform = value.map("personTransform")
  val kind = value.stringOr("kind", "image")
  require(kind == "image" || kind == "video") { "Unsupported background replacement kind '$kind'" }
  return RenderBackgroundReplacement(
    kind = kind,
    uri = value.string("uri"),
    settings = PersonMatteSettings(
      preset = value.stringOr("qualityPreset", "stable"),
      threshold = value.numberOr("threshold", 0.46).toFloat(),
      softness = value.numberOr("softness", 0.14).toFloat(),
      temporalStability = value.numberOr("temporalStability", 0.78).toFloat(),
      edgeFeather = value.numberOr("edgeFeather", 0.45).toFloat(),
    ),
    transform = PersonTransformFrame(
      timeMs = 0,
      transform = PersonTransform(
        positionX = transform.map("position").numberOr("x", 0.5).toFloat(),
        positionY = transform.map("position").numberOr("y", 0.5).toFloat(),
        scale = transform.numberOr("scale", 1).toFloat(),
        rotation = transform.numberOr("rotation", 0).toFloat(),
      ),
    ),
    keyframes = value.list("keyframes").map { frame ->
      PersonTransformFrame(
        timeMs = frame.number("timeMs").toLong(),
        transform = PersonTransform(
          positionX = frame.map("position").numberOr("x", 0.5).toFloat(),
          positionY = frame.map("position").numberOr("y", 0.5).toFloat(),
          scale = frame.numberOr("scale", 1).toFloat(),
          rotation = frame.numberOr("rotation", 0).toFloat(),
        ),
      )
    }.sortedBy(PersonTransformFrame::timeMs),
  )
}

private fun parseCaption(value: Map<String, Any>) = RenderCaption(
  id = value.string("id"),
  text = value.string("text"),
  startMs = value.number("startMs").toLong(),
  endMs = value.number("endMs").toLong(),
  style = parseTextStyle(value.map("style")),
  words = value.list("words").map { word ->
    RenderWord(
      text = word.string("text"),
      startMs = word.number("startMs").toLong(),
      endMs = word.number("endMs").toLong(),
      style = parseTextStyle(word.map("style")),
    )
  },
)

private fun parseTextStyle(value: Map<String, Any>): RenderTextStyle {
  val font = value.map("font")
  val fontUri = font.optionalNonBlankString("uri")
  val fontSource = font.stringOr("source", "system")
  require(fontSource in FONT_SOURCES) { "Unsupported font source '$fontSource'" }
  require(fontSource == "system" || fontUri != null) {
    "Font source '$fontSource' requires a resolved font URI"
  }
  val stroke = value.map("stroke")
  val shadow = value.map("shadow")
  val background = value.map("background")
  val position = value.map("position")
  val box = value.map("box")
  val animation = value.map("animation")
  return RenderTextStyle(
    fontSource = fontSource,
    fontFamily = font.stringOr("family", "sans-serif"),
    fontUri = fontUri,
    fontSize = value.numberOr("fontSize", 48).toFloat().coerceIn(6f, 400f),
    fontWeight = value.stringOr("fontWeight", "800").toIntOrNull()?.coerceIn(100, 900) ?: 800,
    italic = value.booleanOr("italic", false),
    textColor = value.colorOr("textColor", "#FFFFFF", "textColor"),
    secondaryTextColor = value.colorOr("secondaryTextColor", "#FF4FD8", "secondaryTextColor"),
    textTreatment = value.stringOr("textTreatment", "solid"),
    activeWordColor = value.colorOr("activeWordColor", "#DFFF35", "activeWordColor"),
    strokeColor = stroke.colorOr("color", "#111111", "stroke.color"),
    strokeWidth = stroke.numberOr("width", 3).toFloat().coerceIn(0f, 40f),
    shadowColor = shadow.colorOr("color", "#000000", "shadow.color"),
    shadowOpacity = shadow.numberOr("opacity", 0.45).toFloat().coerceIn(0f, 1f),
    shadowBlur = shadow.numberOr("blur", 4).toFloat().coerceIn(0f, 80f),
    shadowOffsetX = shadow.numberOr("offsetX", 0).toFloat(),
    shadowOffsetY = shadow.numberOr("offsetY", 3).toFloat(),
    backgroundColor = background.colorOr("color", "#000000", "background.color"),
    backgroundOpacity = background.numberOr("opacity", 0).toFloat().coerceIn(0f, 1f),
    backgroundRadius = background.numberOr("radius", 12).toFloat().coerceAtLeast(0f),
    backgroundPaddingX = background.numberOr("paddingX", 14).toFloat().coerceAtLeast(0f),
    backgroundPaddingY = background.numberOr("paddingY", 8).toFloat().coerceAtLeast(0f),
    alignment = value.stringOr("alignment", "center"),
    letterSpacing = value.numberOr("letterSpacing", 0).toFloat(),
    lineHeight = value.numberOr("lineHeight", 1.05).toFloat().coerceIn(0.5f, 3f),
    textTransform = value.stringOr("textTransform", "none"),
    positionX = position.numberOr("x", 0.5).toFloat(),
    positionY = position.numberOr("y", 0.78).toFloat(),
    boxWidth = box.numberOr("width", 0.86).toFloat().coerceIn(0.02f, 2f),
    boxHeight = box.numberOr("height", 0.2).toFloat().coerceIn(0.02f, 2f),
    rotation = value.numberOr("rotation", 0).toFloat(),
    maxLines = value.numberOr("maxLines", 2).toInt().coerceIn(1, 10),
    animationId = animation.stringOr("id", "none"),
    animationIntensity = animation.numberOr("intensity", 0).toFloat().coerceIn(0f, 1f),
    animationDurationMs = animation.numberOr("durationMs", 1).toLong().coerceAtLeast(1),
  )
}

private fun parseLayer(value: Map<String, Any>): RenderLayer {
  val kind = value.string("kind")
  return when (kind) {
    "captions" -> CaptionRenderLayer(value.string("id"), value.booleanOr("visible", true))
    "text" -> TextRenderLayer(
      id = value.string("id"),
      visible = value.booleanOr("visible", true),
      text = value.string("text"),
      startMs = value.number("startMs").toLong(),
      endMs = value.number("endMs").toLong(),
      style = parseTextStyle(value.map("style")),
    )
    "image" -> ImageRenderLayer(
      id = value.string("id"),
      visible = value.booleanOr("visible", true),
      uri = value.string("uri"),
      startMs = value.number("startMs").toLong(),
      endMs = value.number("endMs").toLong(),
      positionX = value.map("position").numberOr("x", 0.5).toFloat(),
      positionY = value.map("position").numberOr("y", 0.5).toFloat(),
      boxWidth = value.map("box").numberOr("width", 0.3).toFloat(),
      boxHeight = value.map("box").numberOr("height", 0.3).toFloat(),
      rotation = value.numberOr("rotation", 0).toFloat(),
      opacity = value.numberOr("opacity", 1).toFloat().coerceIn(0f, 1f),
    )
    else -> throw IllegalArgumentException("Unsupported render layer kind '$kind'")
  }
}

private fun parseAudioClip(value: Map<String, Any>) = RenderAudioClip(
  id = value.string("id"),
  uri = value.string("uri"),
  startMs = value.number("startMs").toLong(),
  sourceStartMs = value.number("sourceStartMs").toLong(),
  sourceEndMs = value.number("sourceEndMs").toLong(),
  volume = value.numberOr("volume", 1).toFloat().coerceIn(0f, 1f),
  muted = value.booleanOr("muted", false),
  fadeInMs = value.numberOr("fadeInMs", 0).toLong().coerceAtLeast(0),
  fadeOutMs = value.numberOr("fadeOutMs", 0).toLong().coerceAtLeast(0),
).also { clip ->
  require(clip.sourceStartMs >= 0 && clip.sourceEndMs > clip.sourceStartMs) { "Audio clip ${clip.id} has invalid source bounds" }
}

private fun Map<String, Any>.string(name: String) = this[name] as? String
  ?: throw IllegalArgumentException("Render plan field '$name' must be a string")

private fun Map<String, Any>.stringOr(name: String, fallback: String): String = when (val value = this[name]) {
  null -> fallback
  is String -> value
  else -> throw IllegalArgumentException("Render plan field '$name' must be a string")
}
private fun Map<String, Any>.optionalNonBlankString(name: String): String? {
  val value = this[name] ?: return null
  require(value is String) { "Render plan field '$name' must be a string" }
  require(value.isNotBlank()) { "Render plan field '$name' must not be blank" }
  return value
}

private fun Map<String, Any>.colorOr(name: String, fallback: String, fieldName: String): String {
  val value = when (val candidate = this[name]) {
    null -> fallback
    is String -> candidate
    else -> throw IllegalArgumentException("Render plan color '$fieldName' must be a string")
  }
  require(isSupportedAndroidColor(value)) {
    "Render plan color '$fieldName' must be #RRGGBB, #AARRGGBB, or a supported Android color name"
  }
  return value
}

private fun isSupportedAndroidColor(value: String): Boolean {
  if (HEX_COLOR.matches(value)) return true
  return value.lowercase(Locale.ROOT) in ANDROID_COLOR_NAMES
}

private fun Map<String, Any>.number(name: String): Number {
  val value = this[name] as? Number
    ?: throw IllegalArgumentException("Render plan field '$name' must be a number")
  require(value.toDouble().isFinite()) { "Render plan field '$name' must be finite" }
  return value
}
private fun Map<String, Any>.numberOr(name: String, fallback: Number): Number = when (val value = this[name]) {
  null -> fallback
  is Number -> value.also { require(it.toDouble().isFinite()) { "Render plan field '$name' must be finite" } }
  else -> throw IllegalArgumentException("Render plan field '$name' must be a number")
}
private fun Map<String, Any>.optionalNumber(name: String): Number? = when (val value = this[name]) {
  null -> null
  is Number -> value.also { require(it.toDouble().isFinite()) { "Render plan field '$name' must be finite" } }
  else -> throw IllegalArgumentException("Render plan field '$name' must be a number")
}
private fun Map<String, Any>.booleanOr(name: String, fallback: Boolean): Boolean = when (val value = this[name]) {
  null -> fallback
  is Boolean -> value
  else -> throw IllegalArgumentException("Render plan field '$name' must be a boolean")
}

@Suppress("UNCHECKED_CAST")
private fun Map<String, Any>.map(name: String) = this[name] as? Map<String, Any>
  ?: throw IllegalArgumentException("Render plan field '$name' must be an object")

@Suppress("UNCHECKED_CAST")
private fun Map<String, Any>.optionalMap(name: String) = this[name] as? Map<String, Any>

@Suppress("UNCHECKED_CAST")
private fun Map<String, Any>.list(name: String) = (this[name] as? List<*>)
  ?.map { it as? Map<String, Any> ?: throw IllegalArgumentException("Render plan list '$name' contains an invalid item") }
  ?: emptyList()

private val HEX_COLOR = Regex("^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$")

private val FONT_SOURCES = setOf("built-in", "imported", "system")

private val ANDROID_COLOR_NAMES = setOf(
  "aqua",
  "black",
  "blue",
  "cyan",
  "darkgray",
  "darkgrey",
  "fuchsia",
  "gray",
  "green",
  "grey",
  "lightgray",
  "lightgrey",
  "lime",
  "magenta",
  "maroon",
  "navy",
  "olive",
  "purple",
  "red",
  "silver",
  "teal",
  "transparent",
  "white",
  "yellow",
)
