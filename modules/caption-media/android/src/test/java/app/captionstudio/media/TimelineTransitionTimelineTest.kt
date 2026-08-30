package app.captionstudio.media

import androidx.media3.common.C
import kotlin.math.sqrt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TimelineTransitionTimelineTest {
  @Test
  fun dynamicGainProvidersDeclareEveryUnityRegionBoundary() {
    assertEquals(12_346L, dynamicUnityRegionEnd(12_345L, 1f))
    assertEquals(C.TIME_UNSET, dynamicUnityRegionEnd(12_345L, 0.999f))
  }

  @Test
  fun transitionUsesAdvancingRecoverableFramesOnBothSidesOfTheCut() {
    val outgoing = clip(
      id = "outgoing",
      timelineStartMs = 0,
      timelineEndMs = 4_000,
      sourceStartMs = 1_000,
      sourceEndMs = 5_000,
      transitionDurationMs = 1_000,
    )
    val incoming = clip(
      id = "incoming",
      timelineStartMs = 4_000,
      timelineEndMs = 8_000,
      sourceStartMs = 1_000,
      sourceEndMs = 5_000,
    )

    val timeline = TimelineTransitionTimeline.create(
      listOf(outgoing, incoming),
      mapOf(outgoing.uri to 6_000, incoming.uri to 6_000),
    )
    val window = timeline.windows.single()

    assertEquals(3_500L, window.startMs)
    assertEquals(4_500L, window.endMs)
    assertEquals(4_500L, window.outgoingSourceTimeMs(window.startMs))
    assertEquals(5_000L, window.outgoingSourceTimeMs(window.boundaryMs))
    assertEquals(5_500L, window.outgoingSourceTimeMs(window.endMs))
    assertEquals(500L, window.incomingSourceTimeMs(window.startMs))
    assertEquals(1_000L, window.incomingSourceTimeMs(window.boundaryMs))
    assertEquals(1_500L, window.incomingSourceTimeMs(window.endMs))
    assertEquals(1f, window.outgoingPlaybackRate)
    assertEquals(1f, window.incomingPlaybackRate)
  }

  @Test
  fun fullSourceClipsUseAdvancingVisibleTailAndHeadWithoutHiddenHandles() {
    val outgoing = clip(
      id = "outgoing",
      timelineStartMs = 0,
      timelineEndMs = 4_000,
      sourceStartMs = 0,
      sourceEndMs = 4_000,
      availableSourceEndMs = 4_000,
      transitionDurationMs = 600,
    )
    val incoming = clip(
      id = "incoming",
      timelineStartMs = 4_000,
      timelineEndMs = 8_000,
      sourceStartMs = 0,
      sourceEndMs = 4_000,
      availableSourceEndMs = 4_000,
    )

    val timeline = TimelineTransitionTimeline.create(
      listOf(outgoing, incoming),
      mapOf(outgoing.uri to 4_000, incoming.uri to 4_000),
    )
    val window = timeline.windows.single()

    assertEquals(3_700L, window.startMs)
    assertEquals(4_300L, window.endMs)
    assertEquals(3_700L, window.outgoingSourceTimeMs(window.startMs))
    assertEquals(3_850L, window.outgoingSourceTimeMs(window.boundaryMs))
    assertEquals(4_000L, window.outgoingSourceTimeMs(window.endMs))
    assertEquals(0L, window.incomingSourceTimeMs(window.startMs))
    assertEquals(150L, window.incomingSourceTimeMs(window.boundaryMs))
    assertEquals(300L, window.incomingSourceTimeMs(window.endMs))
    assertEquals(0.5f, window.outgoingPlaybackRate)
    assertEquals(0.5f, window.incomingPlaybackRate)

    val outgoingSegments = timeline.audioSegments(outgoing)
    val incomingSegments = timeline.audioSegments(incoming)
    assertEquals(listOf(0L to 3_700L, 3_700L to 4_300L), outgoingSegments.map { it.timelineStartMs to it.timelineEndMs })
    assertEquals(listOf(0L to 3_700L, 3_700L to 4_000L), outgoingSegments.map { it.sourceStartMs to it.sourceEndMs })
    assertEquals(listOf(3_700L to 4_300L, 4_300L to 8_000L), incomingSegments.map { it.timelineStartMs to it.timelineEndMs })
    assertEquals(listOf(0L to 300L, 300L to 4_000L), incomingSegments.map { it.sourceStartMs to it.sourceEndMs })
  }

  @Test
  fun transitionFailsClosedWhenSelectedMediaCannotSupplyItsVisibleTail() {
    val outgoing = clip(
      id = "outgoing",
      timelineStartMs = 0,
      timelineEndMs = 4_000,
      sourceStartMs = 3_900,
      sourceEndMs = 4_000,
      availableSourceEndMs = 4_000,
      transitionDurationMs = 600,
    )
    val incoming = clip(
      id = "incoming",
      timelineStartMs = 4_000,
      timelineEndMs = 8_000,
      sourceStartMs = 0,
      sourceEndMs = 4_000,
      availableSourceEndMs = 4_000,
    )

    val error = assertThrows(IllegalArgumentException::class.java) {
      TimelineTransitionTimeline.create(
        listOf(outgoing, incoming),
        mapOf(outgoing.uri to 4_000, incoming.uri to 4_000),
      )
    }

    assertTrue(error.message.orEmpty().contains("selected video", ignoreCase = true))
  }

  @Test
  fun aClipBetweenTwoTransitionsHasContiguousNonRepeatingAudioSegments() {
    val first = clip(
      id = "first",
      timelineStartMs = 0,
      timelineEndMs = 4_000,
      sourceStartMs = 0,
      sourceEndMs = 4_000,
      availableSourceEndMs = 4_000,
      transitionDurationMs = 600,
    )
    val middle = clip(
      id = "middle",
      timelineStartMs = 4_000,
      timelineEndMs = 8_000,
      sourceStartMs = 0,
      sourceEndMs = 4_000,
      availableSourceEndMs = 4_000,
      transitionDurationMs = 600,
    )
    val last = clip(
      id = "last",
      timelineStartMs = 8_000,
      timelineEndMs = 12_000,
      sourceStartMs = 0,
      sourceEndMs = 4_000,
      availableSourceEndMs = 4_000,
    )
    val timeline = TimelineTransitionTimeline.create(
      listOf(first, middle, last),
      mapOf(first.uri to 4_000, middle.uri to 4_000, last.uri to 4_000),
    )

    val segments = timeline.audioSegments(middle)

    assertEquals(
      listOf(3_700L to 4_300L, 4_300L to 7_700L, 7_700L to 8_300L),
      segments.map { it.timelineStartMs to it.timelineEndMs },
    )
    assertEquals(
      listOf(0L to 300L, 300L to 3_700L, 3_700L to 4_000L),
      segments.map { it.sourceStartMs to it.sourceEndMs },
    )
    assertEquals(listOf(0.5f, 1f, 0.5f), segments.map { it.playbackRate })
  }

  @Test
  fun transitionAudioSegmentsAndEqualPowerGainsStayContinuousAtTheCut() {
    val outgoing = clip(
      id = "outgoing",
      timelineStartMs = 0,
      timelineEndMs = 4_000,
      sourceStartMs = 1_000,
      sourceEndMs = 5_000,
      transitionDurationMs = 1_000,
    )
    val incoming = clip(
      id = "incoming",
      timelineStartMs = 4_000,
      timelineEndMs = 8_000,
      sourceStartMs = 1_000,
      sourceEndMs = 5_000,
    )
    val timeline = TimelineTransitionTimeline.create(
      listOf(outgoing, incoming),
      mapOf(outgoing.uri to 6_000, incoming.uri to 6_000),
    )
    val outgoingSegments = timeline.audioSegments(outgoing)
    val incomingSegments = timeline.audioSegments(incoming)
    val outgoingTransition = outgoingSegments.last()
    val incomingTransition = incomingSegments.first()

    assertEquals(3_500L, outgoingTransition.timelineStartMs)
    assertEquals(4_500L, outgoingTransition.timelineEndMs)
    assertEquals(4_500L, outgoingTransition.sourceStartMs)
    assertEquals(5_500L, outgoingTransition.sourceEndMs)
    assertEquals(3_500L, incomingTransition.timelineStartMs)
    assertEquals(4_500L, incomingTransition.timelineEndMs)
    assertEquals(500L, incomingTransition.sourceStartMs)
    assertEquals(1_500L, incomingTransition.sourceEndMs)
    assertEquals(sqrt(0.5), transitionAudioGain(4_000.0, null, outgoingTransition.rightTransition), 0.0001)
    assertEquals(sqrt(0.5), transitionAudioGain(4_000.0, incomingTransition.leftTransition, null), 0.0001)
    assertEquals(0.0, transitionAudioGain(4_500.0, null, outgoingTransition.rightTransition), 0.0001)
    assertEquals(1.0, transitionAudioGain(4_500.0, incomingTransition.leftTransition, null), 0.0001)
  }

  private fun clip(
    id: String,
    timelineStartMs: Long,
    timelineEndMs: Long,
    sourceStartMs: Long,
    sourceEndMs: Long,
    availableSourceEndMs: Long = 6_000,
    transitionDurationMs: Long = 0,
  ) = RenderVideoClip(
    id = id,
    uri = "content://$id",
    timelineStartMs = timelineStartMs,
    timelineEndMs = timelineEndMs,
    availableSourceStartMs = 0,
    availableSourceEndMs = availableSourceEndMs,
    sourceStartMs = sourceStartMs,
    sourceEndMs = sourceEndMs,
    playbackRate = 1f,
    volume = 1f,
    muted = false,
    fadeInMs = 0,
    fadeOutMs = 0,
    transitionType = if (transitionDurationMs > 0) "crossfade" else "none",
    transitionDurationMs = transitionDurationMs,
    transform = VideoTransform("fit", 0.5f, 0.5f, 1f, 0f),
  )
}
