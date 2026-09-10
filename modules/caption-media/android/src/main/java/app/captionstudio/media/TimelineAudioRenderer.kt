package app.captionstudio.media

import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.SpeedProvider
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import expo.modules.kotlin.Promise
import java.io.File

internal data class TimelineAudioSegment(
  val id: String,
  val sourceUri: String,
  val timelineStartMs: Long,
  val timelineEndMs: Long,
  val sourceStartMs: Long,
  val sourceEndMs: Long,
  val playbackRate: Float,
  val volume: Float,
  val muted: Boolean,
)

internal data class TimelineAudioPlan(
  val durationMs: Long,
  val videoClips: List<TimelineAudioSegment>,
  val audioClips: List<TimelineAudioSegment>,
)

internal fun parseTimelineAudioPlan(value: Map<String, Any?>): TimelineAudioPlan {
  val version = value.requiredLong("version")
  require(version == 1L) { "Unsupported timeline audio plan version" }
  val durationMs = value.requiredLong("durationMs")
  require(durationMs > 0L) { "Timeline audio duration must be positive" }
  fun parseSegments(name: String): List<TimelineAudioSegment> {
    val values = value[name] as? List<*> ?: throw IllegalArgumentException("Timeline audio field '$name' must be a list")
    return values.mapIndexed { index, raw ->
      val item = raw as? Map<*, *> ?: throw IllegalArgumentException("Timeline audio $name item ${index + 1} is invalid")
      val typed = item.entries.associate { (key, field) -> key.toString() to field }
      val segment = TimelineAudioSegment(
        id = typed.requiredString("id"),
        sourceUri = typed.requiredString("sourceUri"),
        timelineStartMs = typed.requiredLong("timelineStartMs"),
        timelineEndMs = typed.requiredLong("timelineEndMs"),
        sourceStartMs = typed.requiredLong("sourceStartMs"),
        sourceEndMs = typed.requiredLong("sourceEndMs"),
        playbackRate = typed.requiredFloat("playbackRate"),
        volume = typed.requiredFloat("volume"),
        muted = typed.requiredBoolean("muted"),
      )
      require(segment.timelineStartMs >= 0L && segment.timelineEndMs <= durationMs && segment.timelineEndMs > segment.timelineStartMs) {
        "Timeline audio $name item ${index + 1} has invalid timeline bounds"
      }
      require(segment.sourceStartMs >= 0L && segment.sourceEndMs > segment.sourceStartMs) {
        "Timeline audio $name item ${index + 1} has invalid source bounds"
      }
      require(segment.playbackRate in 0.1f..8f && segment.volume in 0f..4f) {
        "Timeline audio $name item ${index + 1} has invalid playback values"
      }
      segment
    }
  }
  return TimelineAudioPlan(durationMs, parseSegments("videoClips"), parseSegments("audioClips"))
}

private fun Map<String, Any?>.requiredString(name: String): String =
  (this[name] as? String)?.takeIf { it.isNotBlank() }
    ?: throw IllegalArgumentException("Timeline audio field '$name' must be a non-empty string")

private fun Map<String, Any?>.requiredLong(name: String): Long {
  val value = this[name] as? Number ?: throw IllegalArgumentException("Timeline audio field '$name' must be numeric")
  require(value.toDouble().isFinite()) { "Timeline audio field '$name' must be finite" }
  return value.toLong()
}

private fun Map<String, Any?>.requiredFloat(name: String): Float {
  val value = this[name] as? Number ?: throw IllegalArgumentException("Timeline audio field '$name' must be numeric")
  require(value.toDouble().isFinite()) { "Timeline audio field '$name' must be finite" }
  return value.toFloat()
}

private fun Map<String, Any?>.requiredBoolean(name: String): Boolean =
  this[name] as? Boolean ?: throw IllegalArgumentException("Timeline audio field '$name' must be boolean")

private class ConstantTimelineSpeed(private val speed: Float) : SpeedProvider {
  override fun getSpeed(timeUs: Long): Float = speed
  override fun getNextSpeedChangeTimeUs(timeUs: Long): Long = C.TIME_UNSET
}

internal object TimelineAudioRenderer {
  private data class ActiveRender(
    val transformer: Transformer,
    val output: File,
    val promise: Promise,
  )

  private val handler = Handler(Looper.getMainLooper())
  private var active: ActiveRender? = null

  fun render(context: Context, outputPath: String, plan: TimelineAudioPlan, promise: Promise) {
    handler.post {
      if (active != null) {
        promise.reject("E_TIMELINE_AUDIO_BUSY", "Timeline audio preparation is already running", null)
        return@post
      }
      val output = File(outputPath)
      try {
        output.parentFile?.mkdirs()
        if (output.exists() && !output.delete()) throw IllegalStateException("Temporary timeline audio could not be replaced")
        val composition = buildComposition(context.applicationContext, plan)
        lateinit var transformer: Transformer
        transformer = Transformer.Builder(context.applicationContext)
          .setLooper(Looper.getMainLooper())
          .setAudioMimeType(MimeTypes.AUDIO_AAC)
          .addListener(object : Transformer.Listener {
            override fun onCompleted(composition: Composition, exportResult: ExportResult) {
              val task = claim(transformer) ?: return
              val size = task.output.takeIf { it.isFile }?.length() ?: 0L
              if (size <= 0L) {
                task.output.delete()
                task.promise.reject("E_TIMELINE_AUDIO_EMPTY", "The audible timeline produced no audio data", null)
                return
              }
              task.promise.resolve(mapOf(
                "outputUri" to Uri.fromFile(task.output).toString(),
                "sizeBytes" to size.toDouble(),
                "durationMs" to (
                  exportResult.approximateDurationMs.takeIf { it > 0L }?.toDouble()
                    ?: plan.durationMs.toDouble()
                ),
              ))
            }

            override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
              val task = claim(transformer) ?: return
              task.output.delete()
              task.promise.reject(
                "E_TIMELINE_AUDIO_RENDER",
                "Caption Studio could not prepare the audible timeline. Keep the editor open and try again.",
                exportException,
              )
            }
          })
          .build()
        active = ActiveRender(transformer, output, promise)
        transformer.start(composition, output.absolutePath)
      } catch (error: Throwable) {
        output.delete()
        promise.reject(
          "E_TIMELINE_AUDIO_PREPARE",
          error.message ?: "Caption Studio could not prepare the audible timeline",
          error,
        )
      }
    }
  }

  fun cancel() {
    handler.post {
      val task = active ?: return@post
      active = null
      task.transformer.cancel()
      task.output.delete()
      task.promise.reject("E_TIMELINE_AUDIO_CANCELLED", "Timeline audio preparation was cancelled", null)
    }
  }

  private fun claim(transformer: Transformer): ActiveRender? {
    val task = active ?: return null
    if (task.transformer !== transformer) return null
    active = null
    return task
  }

  private fun buildComposition(context: Context, plan: TimelineAudioPlan): Composition {
    val unreadableSources = mutableSetOf<String>()
    val audioState = mutableMapOf<String, Boolean?>()
    val sequences = (plan.videoClips + plan.audioClips).mapNotNull { segment ->
      if (segment.muted || segment.volume <= 0f) return@mapNotNull null
      val hasAudio = audioState.getOrPut(segment.sourceUri) {
        try {
          mediaHasAudioTrack(context, segment.sourceUri)
        } catch (_: Throwable) {
          unreadableSources += segment.sourceUri
          null
        }
      }
      if (hasAudio != true) return@mapNotNull null
      val clipping = MediaItem.ClippingConfiguration.Builder()
        .setStartPositionMs(segment.sourceStartMs)
        .setEndPositionMs(segment.sourceEndMs)
        .build()
      val mediaItem = MediaItem.Builder()
        .setUri(segment.sourceUri)
        .setClippingConfiguration(clipping)
        .build()
      val edited = EditedMediaItem.Builder(mediaItem)
        .setRemoveVideo(true)
        .setSpeed(ConstantTimelineSpeed(segment.playbackRate))
        .build()
      EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_AUDIO)).apply {
        if (segment.timelineStartMs > 0L) addGap(segment.timelineStartMs * 1_000L)
        addItem(edited)
      }.build()
    }
    if (sequences.isEmpty()) {
      if (unreadableSources.isNotEmpty()) {
        throw IllegalStateException("One or more timeline audio sources are unavailable")
      }
      throw IllegalArgumentException("No audible audio is available on this timeline")
    }
    return Composition.Builder(sequences).build()
  }

  private fun mediaHasAudioTrack(context: Context, sourceUri: String): Boolean {
    val extractor = MediaExtractor()
    return try {
      val uri = Uri.parse(sourceUri)
      when (uri.scheme?.lowercase()) {
        null, "" -> extractor.setDataSource(sourceUri)
        "file" -> extractor.setDataSource(requireNotNull(uri.path))
        else -> extractor.setDataSource(context, uri, null)
      }
      (0 until extractor.trackCount).any { index ->
        extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
      }
    } finally {
      extractor.release()
    }
  }
}
