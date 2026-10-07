package app.captionstudio.media

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.audio.GainProcessor
import androidx.media3.common.audio.SpeedProvider
import androidx.media3.common.util.SpeedProviderUtil
import androidx.media3.transformer.Effects
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Random
import java.util.concurrent.CancellationException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], manifest = Config.NONE)
class TimelineAudioLanePlannerTest {
  private fun timed(start: Long, end: Long, rate: Float = 1f, sourceDurationUs: Long = ((end - start) * rate).toLong()): TimelineAudioLaneItem {
    val media = MediaItem.Builder().setUri("content://media/source").setClippingConfiguration(
      MediaItem.ClippingConfiguration.Builder().setStartPositionUs(100_000).setEndPositionUs(100_000 + sourceDurationUs).build(),
    ).build()
    val speed = object : SpeedProvider {
      override fun getSpeed(timeUs: Long) = rate
      override fun getNextSpeedChangeTimeUs(timeUs: Long) = C.TIME_UNSET
    }
    return timelineAudioLaneItem(start, end, media, speed, Effects(listOf(GainProcessor(TimelineAudioGainProvider(0.35f))), emptyList()))
  }

  @Test fun halfOpenIntervalsAndUnsortedInputUseMinimumLanes() {
    val input = listOf(timed(3_000_000, 4_000_000), timed(0, 1_000_000), timed(1_000_000, 2_000_000), timed(500_000, 1_500_000))
    val lanes = buildTimelineAudioLanes(input, 5_000_000)
    assertEquals(2, lanes.size)
    assertEquals(input.map { it.item }.toSet(), lanes.flatMap { it.editedMediaItems }.filter { it.mediaItem.localConfiguration != null }.toSet())
    lanes.forEach { lane ->
      var duration = 0L
      lane.editedMediaItems.forEach { item ->
        duration += if (item.mediaItem.localConfiguration == null) item.durationUs else {
          val bounds = item.mediaItem.clippingConfiguration
          SpeedProviderUtil.getDurationAfterSpeedProviderApplied(item.speedProvider, bounds.endPositionUs - bounds.startPositionUs)
        }
      }
      assertEquals(5_000_000L, duration)
    }
  }

  @Test fun randomizedNestedAndOverlappingItemsMatchSweepLineMaximum() {
    val random = Random(6145)
    val input = List(1_000) {
      val start = random.nextInt(999_000).toLong()
      timed(start, start + 1 + random.nextInt(1_000))
    }
    val events = input.flatMap { listOf(it.startUs to 1, it.endUs to -1) }.sortedWith(compareBy<Pair<Long, Int>> { it.first }.thenBy { it.second })
    var active = 0
    var peak = 0
    events.forEach { active += it.second; peak = maxOf(peak, active) }
    val lanes = buildTimelineAudioLanes(input, 1_000_000)
    assertEquals(peak, lanes.size)
    assertEquals(1_000, lanes.sumOf { lane -> lane.editedMediaItems.count { it.mediaItem.localConfiguration != null } })
  }

  @Test fun ratesGainsAndSourceBoundsSurvivePackingWithoutDurationDrift() {
    for (rate in listOf(0.1f, 1.1f, 2f, 8f)) {
      val input = List(1_000) { timed(it * 1_000_000L, (it + 1) * 1_000_000L, rate) }
      val lanes = buildTimelineAudioLanes(input, 1_000_000_000L)
      assertEquals(1, lanes.size)
      val items = lanes.single().editedMediaItems.filter { it.mediaItem.localConfiguration != null }
      input.zip(items).forEach { (original, actual) ->
        assertSame(original.item, actual)
        assertEquals(rate, actual.speedProvider.getSpeed(0), 0f)
        assertEquals(100_000L, actual.mediaItem.clippingConfiguration.startPositionUs)
        assertTrue(actual.mediaItem.clippingConfiguration.endPositionUs <= 100_000L + (1_000_000 * rate).toLong())
        assertEquals(1, actual.effects.audioProcessors.size)
      }
      val total = lanes.single().editedMediaItems.sumOf { item ->
        if (item.mediaItem.localConfiguration == null) item.durationUs else {
          val clip = item.mediaItem.clippingConfiguration
          SpeedProviderUtil.getDurationAfterSpeedProviderApplied(item.speedProvider, clip.endPositionUs - clip.startPositionUs)
        }
      }
      assertEquals(1_000_000_000L, total)
    }
  }

  @Test fun explicitTimelineEndCapsOversizedSourceWithoutChangingRate() {
    val bounded = timed(0, 1_000_000, 2f, 4_000_000)
    assertEquals(2f, bounded.item.speedProvider.getSpeed(0), 0f)
    assertEquals(2_100_000L, bounded.item.mediaItem.clippingConfiguration.endPositionUs)
    assertEquals(1_000_000L, bounded.presentationDurationUs)
  }

  @Test fun shortSourceLeavesSilenceRatherThanStretching() {
    val short = timed(0, 1_000_000, 1f, 500_000)
    val lane = buildTimelineAudioLanes(listOf(short, timed(1_000_000, 2_000_000)), 3_000_000).single()
    assertEquals(listOf(500_000L, 1_000_000L), lane.editedMediaItems.filter { it.mediaItem.localConfiguration == null }.map { it.durationUs })
  }

  @Test fun invalidBoundsAndOverflowFailBeforeMedia3Starts() {
    assertThrows(IllegalArgumentException::class.java) { timed(100, 100) }
    assertThrows(IllegalArgumentException::class.java) { buildTimelineAudioLanes(listOf(timed(0, 2_000)), 1_000) }
    assertThrows(ArithmeticException::class.java) { timelineAudioUs(Long.MAX_VALUE) }
    assertTrue(buildTimelineAudioLanes(emptyList(), 1_000).isEmpty())
  }

  @Test fun cancellationStopsPlanningAndSequenceAssembly() {
    val input = List(52) { timed(it * 1_000L, (it + 1) * 1_000L) }
    for (cancelAt in listOf(1, 60, 110)) {
      var calls = 0
      assertThrows(CancellationException::class.java) {
        buildTimelineAudioLanes(input, 52_000) { if (++calls == cancelAt) throw CancellationException("cancelled") }
      }
      assertEquals(cancelAt, calls)
    }
  }
}
