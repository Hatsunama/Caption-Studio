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
import androidx.media3.common.audio.GainProcessor
import androidx.media3.transformer.Composition
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import expo.modules.kotlin.Promise
import java.io.File
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CancellationException
import java.util.concurrent.Future
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

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

internal class TimelineAudioGainProvider(private val volume: Float) : GainProcessor.GainProvider {
  override fun getGainFactorAtSamplePosition(samplePosition: Long, sampleRate: Int): Float = volume
  override fun isUnityUntil(samplePosition: Long, sampleRate: Int): Long =
    dynamicUnityRegionEnd(samplePosition, volume)
}

internal fun selectAudibleTimelineSegments(
  plan: TimelineAudioPlan,
  hasAudioTrack: (String) -> Boolean,
): List<TimelineAudioSegment> {
  val audioState = mutableMapOf<String, Boolean>()
  val candidates = plan.videoClips.map { it to false } + plan.audioClips.map { it to true }
  return candidates.mapNotNull { (segment, insertedAudio) ->
    if (segment.muted || segment.volume <= 0f) return@mapNotNull null
    val hasAudio = try {
      audioState.getOrPut(segment.sourceUri) { hasAudioTrack(segment.sourceUri) }
    } catch (error: Exception) {
      throw IllegalStateException("Timeline audio source ${segment.sourceUri} is unavailable", error)
    }
    if (!hasAudio && insertedAudio) {
      throw IllegalStateException("Added timeline audio source ${segment.sourceUri} has no readable audio track")
    }
    segment.takeIf { hasAudio }
  }
}

internal fun finishCancelledTimelineAudioRender(
  cancelTransformer: () -> Unit,
  cleanup: () -> Unit,
  reject: () -> Unit,
) {
  try {
    cancelTransformer()
  } catch (_: Throwable) {
    // Cancellation must still settle the promise even if Transformer.cancel fails.
  } finally {
    try {
      cleanup()
    } finally {
      reject()
    }
  }
}

internal object TimelineAudioRenderer {
  private data class ActiveRender(
    val output: File,
    val promise: Promise,
    var preparation: Future<*>? = null,
    var transformer: Transformer? = null,
    var outputPrepared: Boolean = false,
  )

  private val handler = Handler(Looper.getMainLooper())
  private val preflightWorkers = ThreadPoolExecutor(
    1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(1),
    { runnable -> Thread(runnable, "timeline-audio-preflight").apply { isDaemon = true } },
    ThreadPoolExecutor.AbortPolicy(),
  )
  private var active: ActiveRender? = null

  fun render(context: Context, outputPath: String, plan: TimelineAudioPlan, promise: Promise) {
    handler.post {
      if (active != null) {
        promise.reject("E_TIMELINE_AUDIO_BUSY", "Timeline audio preparation is already running", null)
        return@post
      }
      val task = ActiveRender(File(outputPath), promise)
      active = task
      try {
        preflightWorkers.purge()
        task.preparation = preflightWorkers.submit {
          val result = runCatching {
            val appContext = context.applicationContext
            val policy = MediaInputPolicy(appContext)
            (plan.videoClips + plan.audioClips).forEach {
              checkPreflightCancellation()
              policy.requireInput(it.sourceUri)
            }
            buildComposition(appContext, plan)
          }
          handler.post {
            if (active !== task) return@post
            result.fold(
              onSuccess = { composition -> startRender(context.applicationContext, plan, task, composition) },
              onFailure = { error -> failPreparation(task, error) },
            )
          }
        }
      } catch (error: Exception) {
        failPreparation(task, error)
      }
    }
  }

  private fun startRender(context: Context, plan: TimelineAudioPlan, task: ActiveRender, composition: Composition) {
    try {
      task.output.parentFile?.mkdirs()
      if (task.output.exists() && !task.output.delete()) throw IllegalStateException("Temporary timeline audio could not be replaced")
      task.outputPrepared = true
      lateinit var transformer: Transformer
      transformer = Transformer.Builder(context)
          .setLooper(Looper.getMainLooper())
          .setAudioMimeType(MimeTypes.AUDIO_AAC)
          .addListener(object : Transformer.Listener {
            override fun onCompleted(composition: Composition, exportResult: ExportResult) {
              val completed = claim(transformer) ?: return
              val size = completed.output.takeIf { it.isFile }?.length() ?: 0L
              if (size <= 0L) {
                completed.output.delete()
                completed.promise.reject("E_TIMELINE_AUDIO_EMPTY", "The audible timeline produced no audio data", null)
                return
              }
              completed.promise.resolve(mapOf(
                "outputUri" to Uri.fromFile(completed.output).toString(),
                "sizeBytes" to size.toDouble(),
                "durationMs" to (
                  exportResult.approximateDurationMs.takeIf { it > 0L }?.toDouble()
                    ?: plan.durationMs.toDouble()
                ),
              ))
            }

            override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
              val failed = claim(transformer) ?: return
              failed.output.delete()
              failed.promise.reject(
                "E_TIMELINE_AUDIO_RENDER",
                "Caption Studio could not prepare the audible timeline. Keep the editor open and try again.",
                exportException,
              )
            }
          })
          .build()
      task.transformer = transformer
      transformer.start(composition, task.output.absolutePath)
    } catch (error: Throwable) {
      failPreparation(task, error)
    }
  }

  private fun failPreparation(task: ActiveRender, error: Throwable) {
    if (active !== task) return
    active = null
    if (task.outputPrepared) task.output.delete()
    task.promise.reject(
      "E_TIMELINE_AUDIO_PREPARE",
      error.message ?: "Caption Studio could not prepare the audible timeline",
      error,
    )
  }

  fun cancel() {
    handler.post {
      val task = active ?: return@post
      active = null
      task.preparation?.cancel(true)
      finishCancelledTimelineAudioRender(
        cancelTransformer = { task.transformer?.cancel() },
        cleanup = { if (task.outputPrepared) task.output.delete() },
        reject = { task.promise.reject("E_TIMELINE_AUDIO_CANCELLED", "Timeline audio preparation was cancelled", null) },
      )
    }
  }

  private fun claim(transformer: Transformer): ActiveRender? {
    val task = active ?: return null
    if (task.transformer !== transformer) return null
    active = null
    return task
  }

  private fun buildComposition(context: Context, plan: TimelineAudioPlan): Composition {
    val items = selectAudibleTimelineSegments(plan) { mediaHasAudioTrack(context, it) }.map { segment ->
      checkPreflightCancellation()
      val clipping = MediaItem.ClippingConfiguration.Builder()
        .setStartPositionMs(segment.sourceStartMs)
        .setEndPositionMs(segment.sourceEndMs)
        .build()
      val mediaItem = MediaItem.Builder()
        .setUri(MediaInputPolicy(context).requireInput(segment.sourceUri))
        .setClippingConfiguration(clipping)
        .build()
      timelineAudioLaneItem(
        timelineAudioUs(segment.timelineStartMs),
        timelineAudioUs(segment.timelineEndMs),
        mediaItem,
        ConstantTimelineSpeed(segment.playbackRate),
        Effects(listOf(GainProcessor(TimelineAudioGainProvider(segment.volume))), emptyList()),
      )
    }
    val sequences = buildTimelineAudioLanes(items, timelineAudioUs(plan.durationMs), ::checkPreflightCancellation)
    if (sequences.isEmpty()) {
      throw IllegalArgumentException("No audible audio is available on this timeline")
    }
    return Composition.Builder(sequences).build()
  }

  private fun mediaHasAudioTrack(context: Context, sourceUri: String): Boolean {
    checkPreflightCancellation()
    val extractor = MediaExtractor()
    return try {
      val uri = MediaInputPolicy(context).requireInput(sourceUri)
      when (uri.scheme?.lowercase()) {
        "file" -> extractor.setDataSource(requireNotNull(uri.path))
        "content" -> extractor.setDataSource(context, uri, null)
        else -> throw IllegalArgumentException("The audio source URI is invalid")
      }
      (0 until extractor.trackCount).any { index ->
        checkPreflightCancellation()
        extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
      }
    } finally {
      extractor.release()
    }
  }

  private fun checkPreflightCancellation() {
    if (Thread.currentThread().isInterrupted) throw CancellationException("Timeline audio preparation was cancelled")
  }
}
