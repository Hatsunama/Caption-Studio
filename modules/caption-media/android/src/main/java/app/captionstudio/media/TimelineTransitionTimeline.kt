package app.captionstudio.media

import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.roundToLong
import kotlin.math.sin

internal data class TimelineTransitionWindow(
  val outgoing: RenderVideoClip,
  val incoming: RenderVideoClip,
  val startMs: Long,
  val boundaryMs: Long,
  val endMs: Long,
  val outgoingSourceStartMs: Long,
  val outgoingSourceEndMs: Long,
  val incomingSourceStartMs: Long,
  val incomingSourceEndMs: Long,
) {
  val durationMs = endMs - startMs
  val beforeBoundaryMs = boundaryMs - startMs
  val afterBoundaryMs = endMs - boundaryMs
  val outgoingPlaybackRate = sourceRate(outgoingSourceStartMs, outgoingSourceEndMs, durationMs)
  val incomingPlaybackRate = sourceRate(incomingSourceStartMs, incomingSourceEndMs, durationMs)

  fun phaseAt(timeMs: Long) = ((timeMs - startMs).toFloat() / durationMs).coerceIn(0f, 1f)

  fun outgoingSourceTimeMs(timeMs: Long) = interpolateSourceTime(
    outgoingSourceStartMs,
    outgoingSourceEndMs,
    timeMs,
  )

  fun incomingSourceTimeMs(timeMs: Long) = interpolateSourceTime(
    incomingSourceStartMs,
    incomingSourceEndMs,
    timeMs,
  )

  private fun interpolateSourceTime(sourceStartMs: Long, sourceEndMs: Long, timeMs: Long): Long {
    val phase = ((timeMs - startMs).toDouble() / durationMs).coerceIn(0.0, 1.0)
    return sourceStartMs + ((sourceEndMs - sourceStartMs) * phase).roundToLong()
  }
}

internal data class ClipAudioSegment(
  val timelineStartMs: Long,
  val timelineEndMs: Long,
  val sourceStartMs: Long,
  val sourceEndMs: Long,
  val playbackRate: Float,
  val leftTransition: TimelineTransitionWindow?,
  val rightTransition: TimelineTransitionWindow?,
)

internal class TimelineTransitionTimeline private constructor(
  val windows: List<TimelineTransitionWindow>,
) {
  private val leftByClipId = windows.associateBy { it.incoming.id }
  private val rightByClipId = windows.associateBy { it.outgoing.id }

  fun activeAt(timeMs: Long) = windows.firstOrNull { timeMs in it.startMs until it.endMs }

  fun audioSegments(clip: RenderVideoClip): List<ClipAudioSegment> {
    val left = leftByClipId[clip.id]
    val right = rightByClipId[clip.id]
    val segments = mutableListOf<ClipAudioSegment>()
    if (left != null) {
      segments += audioSegment(
        timelineStartMs = left.startMs,
        timelineEndMs = left.endMs,
        sourceStartMs = left.incomingSourceStartMs,
        sourceEndMs = left.incomingSourceEndMs,
        leftTransition = left,
        rightTransition = right,
      )
    }
    val middleTimelineStartMs = left?.endMs ?: clip.timelineStartMs
    val middleTimelineEndMs = right?.startMs ?: clip.timelineEndMs
    val middleSourceStartMs = left?.incomingSourceEndMs ?: clip.sourceStartMs
    val middleSourceEndMs = right?.outgoingSourceStartMs ?: clip.sourceEndMs
    if (middleTimelineEndMs > middleTimelineStartMs) {
      require(middleSourceEndMs > middleSourceStartMs) {
        "Transitions consume all selected audio from clip ${clip.id}"
      }
      segments += audioSegment(
        timelineStartMs = middleTimelineStartMs,
        timelineEndMs = middleTimelineEndMs,
        sourceStartMs = middleSourceStartMs,
        sourceEndMs = middleSourceEndMs,
        leftTransition = left,
        rightTransition = right,
      )
    }
    if (right != null) {
      segments += audioSegment(
        timelineStartMs = right.startMs,
        timelineEndMs = right.endMs,
        sourceStartMs = right.outgoingSourceStartMs,
        sourceEndMs = right.outgoingSourceEndMs,
        leftTransition = left,
        rightTransition = right,
      )
    }
    require(segments.isNotEmpty()) { "Clip ${clip.id} has no exportable audio duration" }
    require(segments.zipWithNext().all { (first, second) -> first.timelineEndMs == second.timelineStartMs }) {
      "Clip ${clip.id} audio transition segments are not contiguous"
    }
    return segments
  }

  companion object {
    fun create(clips: List<RenderVideoClip>, sourceDurationMsByUri: Map<String, Long>): TimelineTransitionTimeline {
      val windows = clips.zipWithNext().mapNotNull { (outgoing, incoming) ->
        if (outgoing.transitionType == "none" || outgoing.transitionDurationMs <= 0) return@mapNotNull null
        require(incoming.timelineStartMs == outgoing.timelineEndMs) {
          "Transition after clip ${outgoing.id} requires adjacent clips with no timeline gap"
        }
        val durationMs = min(
          outgoing.transitionDurationMs,
          min(outgoing.timelineDurationMs, incoming.timelineDurationMs),
        ).coerceAtLeast(2L)
        val beforeBoundaryMs = durationMs / 2L
        val afterBoundaryMs = durationMs - beforeBoundaryMs
        val outgoingAvailableEndMs = min(
          outgoing.availableSourceEndMs,
          sourceDurationMsByUri[outgoing.uri]
            ?: throw IllegalArgumentException("Clip ${outgoing.id} source duration is unavailable"),
        )
        val incomingAvailableEndMs = min(
          incoming.availableSourceEndMs,
          sourceDurationMsByUri[incoming.uri]
            ?: throw IllegalArgumentException("Clip ${incoming.id} source duration is unavailable"),
        )
        val incomingAvailableStartMs = incoming.availableSourceStartMs
        require(outgoing.sourceEndMs <= outgoingAvailableEndMs) {
          "Clip ${outgoing.id} ends after its readable source media"
        }
        require(incoming.sourceEndMs <= incomingAvailableEndMs) {
          "Clip ${incoming.id} ends after its readable source media"
        }
        val outgoingVisibleStartMs = outgoing.sourceEndMs - sourceDurationMs(beforeBoundaryMs, outgoing.playbackRate)
        val incomingVisibleEndMs = incoming.sourceStartMs + sourceDurationMs(afterBoundaryMs, incoming.playbackRate)
        require(outgoingVisibleStartMs >= outgoing.sourceStartMs) {
          "Transition after clip ${outgoing.id} needs more selected video before the cut"
        }
        require(incomingVisibleEndMs <= incoming.sourceEndMs) {
          "Transition before clip ${incoming.id} needs more selected video after the cut"
        }
        val outgoingHandleEndMs = outgoing.sourceEndMs + sourceDurationMs(afterBoundaryMs, outgoing.playbackRate)
        val incomingHandleStartMs = incoming.sourceStartMs - sourceDurationMs(beforeBoundaryMs, incoming.playbackRate)
        TimelineTransitionWindow(
          outgoing = outgoing,
          incoming = incoming,
          startMs = outgoing.timelineEndMs - beforeBoundaryMs,
          boundaryMs = outgoing.timelineEndMs,
          endMs = outgoing.timelineEndMs + afterBoundaryMs,
          outgoingSourceStartMs = outgoingVisibleStartMs,
          outgoingSourceEndMs = if (outgoingHandleEndMs <= outgoingAvailableEndMs) outgoingHandleEndMs else outgoing.sourceEndMs,
          incomingSourceStartMs = if (incomingHandleStartMs >= incomingAvailableStartMs) incomingHandleStartMs else incoming.sourceStartMs,
          incomingSourceEndMs = incomingVisibleEndMs,
        )
      }
      require(windows.zipWithNext().all { (first, second) -> first.endMs <= second.startMs }) {
        "Adjacent transitions overlap; shorten one of their durations"
      }
      return TimelineTransitionTimeline(windows)
    }
  }
}

private fun audioSegment(
  timelineStartMs: Long,
  timelineEndMs: Long,
  sourceStartMs: Long,
  sourceEndMs: Long,
  leftTransition: TimelineTransitionWindow?,
  rightTransition: TimelineTransitionWindow?,
) = ClipAudioSegment(
  timelineStartMs = timelineStartMs,
  timelineEndMs = timelineEndMs,
  sourceStartMs = sourceStartMs,
  sourceEndMs = sourceEndMs,
  playbackRate = sourceRate(sourceStartMs, sourceEndMs, timelineEndMs - timelineStartMs),
  leftTransition = leftTransition,
  rightTransition = rightTransition,
)

internal fun transitionAudioGain(
  timelineTimeMs: Double,
  left: TimelineTransitionWindow?,
  right: TimelineTransitionWindow?,
): Double {
  var gain = 1.0
  if (left != null && timelineTimeMs < left.endMs) {
    val phase = ((timelineTimeMs - left.startMs) / left.durationMs).coerceIn(0.0, 1.0)
    gain *= sin(phase * PI / 2.0)
  }
  if (right != null && timelineTimeMs >= right.startMs) {
    val phase = ((timelineTimeMs - right.startMs) / right.durationMs).coerceIn(0.0, 1.0)
    gain *= cos(phase * PI / 2.0)
  }
  return gain.coerceIn(0.0, 1.0)
}

private fun sourceDurationMs(timelineDurationMs: Long, playbackRate: Float) =
  ceil(timelineDurationMs * playbackRate.toDouble()).toLong()

private fun sourceRate(sourceStartMs: Long, sourceEndMs: Long, timelineDurationMs: Long): Float {
  require(timelineDurationMs > 0 && sourceEndMs > sourceStartMs) { "A transition segment has invalid media bounds" }
  val rate = ((sourceEndMs - sourceStartMs).toDouble() / timelineDurationMs).toFloat()
  require(rate in 0.1f..8f) { "A transition segment requires an unsupported playback rate" }
  return rate
}
