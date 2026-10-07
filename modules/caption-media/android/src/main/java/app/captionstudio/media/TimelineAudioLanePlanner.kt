package app.captionstudio.media

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.audio.SpeedProvider
import androidx.media3.common.util.SpeedProviderUtil
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import java.util.PriorityQueue
import kotlin.math.min

/** Half-open timeline bounds reserve a lane; presentation duration determines its silent gaps. */
internal data class TimelineAudioLaneItem(
  val startUs: Long,
  val endUs: Long,
  val presentationDurationUs: Long,
  val item: EditedMediaItem,
)

/**
 * Keep the requested rate and source start. Only constrain the source end when it would play
 * beyond the explicit timeline end. Work in microseconds so rounding cannot accumulate per cut.
 */
internal fun timelineAudioLaneItem(
  startUs: Long,
  endUs: Long,
  mediaItem: MediaItem,
  speed: SpeedProvider,
  effects: Effects,
): TimelineAudioLaneItem {
  require(startUs >= 0L && endUs > startUs) { "Invalid timeline audio item bounds" }
  val clipping = mediaItem.clippingConfiguration
  val sourceStartUs = clipping.startPositionUs
  var sourceEndUs = clipping.endPositionUs
  require(sourceStartUs >= 0L && sourceEndUs > sourceStartUs) { "Invalid timeline audio source bounds" }
  val rate = speed.getSpeed(0)
  require(rate.isFinite() && rate in 0.1f..8f && speed.getNextSpeedChangeTimeUs(0) == C.TIME_UNSET) {
    "Timeline audio requires a constant supported playback rate"
  }
  val availableUs = endUs - startUs
  var presentationUs = SpeedProviderUtil.getDurationAfterSpeedProviderApplied(speed, sourceEndUs - sourceStartUs)
  if (presentationUs > availableUs) {
    val boundedSourceDurationUs = min(sourceEndUs - sourceStartUs, (availableUs * rate.toDouble()).toLong())
    sourceEndUs = Math.addExact(sourceStartUs, boundedSourceDurationUs)
    presentationUs = SpeedProviderUtil.getDurationAfterSpeedProviderApplied(speed, boundedSourceDurationUs)
  }
  require(presentationUs > 0L && presentationUs <= availableUs) { "Timeline audio has no bounded source duration" }
  val boundedMediaItem = if (sourceEndUs == clipping.endPositionUs) mediaItem else {
    mediaItem.buildUpon().setClippingConfiguration(
      clipping.buildUpon().setEndPositionUs(sourceEndUs).build(),
    ).build()
  }
  val edited = EditedMediaItem.Builder(boundedMediaItem)
    .setRemoveVideo(true)
    .setSpeed(speed)
    .setEffects(effects)
    .build()
  return TimelineAudioLaneItem(startUs, endUs, presentationUs, edited)
}

/**
 * Interval partitioning: reuse the earliest finishing lane, or open a lane only when every
 * existing lane overlaps. Lane count equals maximum simultaneous overlap, independent of cuts.
 * Each sequence plays its items sequentially; Media3 mixes the sequences in parallel.
 */
internal fun buildTimelineAudioLanes(
  items: List<TimelineAudioLaneItem>,
  durationUs: Long,
  checkCancelled: () -> Unit = {},
): List<EditedMediaItemSequence> {
  require(durationUs > 0L) { "Timeline audio duration must be positive" }
  val lanes = mutableListOf<MutableList<TimelineAudioLaneItem>>()
  val available = PriorityQueue<Int>(compareBy<Int> { lanes[it].last().endUs }.thenBy { it })
  items.forEach {
    checkCancelled()
    require(it.startUs >= 0L && it.endUs > it.startUs && it.endUs <= durationUs) { "Audio item extends outside the timeline" }
    require(it.presentationDurationUs > 0L && it.presentationDurationUs <= it.endUs - it.startUs) { "Audio item exceeds its reserved duration" }
  }
  checkCancelled()
  items.sortedWith(compareBy<TimelineAudioLaneItem> { it.startUs }.thenBy { it.endUs }).forEach { item ->
    checkCancelled()
    val lane = if (available.isNotEmpty() && lanes[available.peek()].last().endUs <= item.startUs) {
      available.remove()
    } else {
      lanes.add(mutableListOf())
      lanes.lastIndex
    }
    lanes[lane].add(item)
    available.add(lane)
  }
  return lanes.map { lane ->
    checkCancelled()
    val builder = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_AUDIO))
    var cursorUs = 0L
    lane.forEach { item ->
      checkCancelled()
      if (item.startUs > cursorUs) builder.addGap(item.startUs - cursorUs)
      builder.addItem(item.item)
      cursorUs = Math.addExact(item.startUs, item.presentationDurationUs)
    }
    if (cursorUs < durationUs) builder.addGap(durationUs - cursorUs)
    builder.build()
  }
}

internal fun timelineAudioUs(milliseconds: Long): Long = Math.multiplyExact(milliseconds, 1_000L)
