package app.captionstudio.media

import androidx.media3.common.audio.GainProcessor
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class TimelineTransitionCoverAudioClockTest {
  @Test fun dipBlackClock() = coverClock("dip-black")
  @Test fun dipWhiteClock() = coverClock("dip-white")
  @Test fun flashClock() = coverClock("flash")
  @Test fun fadeDarkClock() = coverClock("fade-dark")
  @Test fun shutterClock() = coverClock("shutter")
  @Test fun cyanWashClock() = coverClock("color-wash-cyan")
  @Test fun magentaWashClock() = coverClock("color-wash-magenta")

  @Test fun dipBlackGain() = coverGain("dip-black")
  @Test fun dipWhiteGain() = coverGain("dip-white")
  @Test fun flashGain() = coverGain("flash")
  @Test fun fadeDarkGain() = coverGain("fade-dark")
  @Test fun shutterGain() = coverGain("shutter")
  @Test fun cyanWashGain() = coverGain("color-wash-cyan")
  @Test fun magentaWashGain() = coverGain("color-wash-magenta")

  private fun coverClock(type: String) {
    val (outgoing, incoming, timeline) = fixture(type)
    val window = timeline.windows.single()
    assertEquals(3_700L, window.startMs)
    assertEquals(4_000L, window.boundaryMs)
    assertEquals(4_300L, window.endMs)
    for (clip in listOf(outgoing, incoming)) {
      val segments = timeline.audioSegments(clip)
      // Do not prescribe whether the implementation merges ordinary-rate segments.
      assertEquals("$type ${clip.id} must start on its own side of the cut", clip.timelineStartMs, segments.first().timelineStartMs)
      assertEquals("$type ${clip.id} must end on its own side of the cut", clip.timelineEndMs, segments.last().timelineEndMs)
      segments.forEach { segment ->
        assertEquals("$type ${clip.id} ordinary audio rate", clip.playbackRate, segment.playbackRate, 0f)
        assertEquals(segment.timelineStartMs - clip.timelineStartMs, segment.sourceStartMs)
        assertEquals(segment.timelineEndMs - clip.timelineStartMs, segment.sourceEndMs)
      }
      assertTrue(segments.zipWithNext().all { (a, b) ->
        a.timelineEndMs == b.timelineStartMs && a.sourceEndMs == b.sourceStartMs
      })
      val times = if (clip == outgoing) listOf(3_700L, 3_850L, 3_999L) else listOf(4_000L, 4_150L, 4_299L)
      times.forEach { time ->
        val segment = segments.single { time >= it.timelineStartMs && time < it.timelineEndMs }
        assertEquals("$type source clock at $time", (time - clip.timelineStartMs).toDouble(),
          segment.sourceStartMs + (time - segment.timelineStartMs) * segment.playbackRate.toDouble(), 0.0001)
      }
      assertEquals(if (clip == outgoing) 4_000L else 0L,
        if (clip == outgoing) segments.last().sourceEndMs else segments.first().sourceStartMs)
    }
  }

  private fun coverGain(type: String) {
    val (_, _, timeline) = fixture(type)
    val window = timeline.windows.single()
    // Quarter points of the full window are halfway through each cover half.
    listOf(3_699.0 to 1.0, 3_700.0 to 1.0, 3_850.0 to sqrt(0.5),
      4_000.0 to 0.0, 4_150.0 to 0.0, 4_300.0 to 0.0).forEach { (time, gain) ->
      assertEquals("$type outgoing gain at $time", gain, transitionAudioGain(time, null, window), 0.000001)
    }
    listOf(3_700.0 to 0.0, 3_850.0 to 0.0, 4_000.0 to 0.0,
      4_150.0 to sqrt(0.5), 4_300.0 to 1.0, 4_301.0 to 1.0).forEach { (time, gain) ->
      assertEquals("$type incoming gain at $time", gain, transitionAudioGain(time, window, null), 0.000001)
    }
  }

  @Test fun coverGainProviderStillMultipliesUserFadesAndVolume() {
    TimelineTransitionSpec.coverTypes.forEach { type ->
      val (outgoing, incoming, timeline) = fixture(type)
      listOf(outgoing.copy(volume = 0.4f, fadeOutMs = 600),
        incoming.copy(volume = 0.4f, fadeInMs = 600)).forEach { clip ->
        val time = if (clip.id == "outgoing") 3_850L else 4_150L
        val segment = timeline.audioSegments(clip).single { time >= it.timelineStartMs && time < it.timelineEndMs }
        val provider = gainProvider(clip, segment)
        val sourceElapsedMs = ((time - segment.timelineStartMs) * segment.playbackRate).toLong()
        assertEquals("$type ${clip.id}: volume * user fade * cover gain",
          (0.4 * 0.25 * sqrt(0.5)).toFloat(),
          provider.getGainFactorAtSamplePosition(sourceElapsedMs * 48, 48_000), 0.00001f)
      }
    }
  }

  @Test fun compositesKeepFullWindowHalfSpeedSourceClockAndEqualPowerOverlap() {
    TimelineTransitionSpec.compositeTypes.forEach { type ->
      val (outgoing, incoming, timeline) = fixture(type)
      val window = timeline.windows.single()
      val out = timeline.audioSegments(outgoing).last()
      val next = timeline.audioSegments(incoming).first()
      listOf(out, next).forEach {
        assertEquals(3_700L, it.timelineStartMs)
        assertEquals(4_300L, it.timelineEndMs)
        assertEquals(0.5f, it.playbackRate, 0f)
      }
      assertEquals(3_700L to 4_000L, out.sourceStartMs to out.sourceEndMs)
      assertEquals(0L to 300L, next.sourceStartMs to next.sourceEndMs)
      assertEquals(3_850L, window.outgoingSourceTimeMs(4_000))
      assertEquals(150L, window.incomingSourceTimeMs(4_000))
      listOf(3_700.0, 3_850.0, 4_000.0, 4_150.0, 4_300.0).forEach { time ->
        val angle = (time - 3_700) / 600 * PI / 2
        assertEquals("$type outgoing", cos(angle), transitionAudioGain(time, null, window), 0.000001)
        assertEquals("$type incoming", sin(angle), transitionAudioGain(time, window, null), 0.000001)
      }
    }
  }

  // Read the existing private provider rather than adding a product constructor seam.
  private fun gainProvider(clip: RenderVideoClip, segment: ClipAudioSegment): GainProcessor.GainProvider {
    val constructor = Class.forName("app.captionstudio.media.TimelineClipGainProvider")
      .getDeclaredConstructor(RenderVideoClip::class.java, ClipAudioSegment::class.java)
    constructor.isAccessible = true
    return constructor.newInstance(clip, segment) as GainProcessor.GainProvider
  }

  private fun fixture(type: String): Triple<RenderVideoClip, RenderVideoClip, TimelineTransitionTimeline> {
    val outgoing = RenderVideoClip(
      id = "outgoing", uri = "content://outgoing", timelineStartMs = 0, timelineEndMs = 4_000,
      availableSourceStartMs = 0, availableSourceEndMs = 4_000, sourceStartMs = 0, sourceEndMs = 4_000,
      playbackRate = 1f, volume = 1f, muted = false, fadeInMs = 0, fadeOutMs = 0,
      transitionType = type, transitionDurationMs = 600,
      transform = VideoTransform("fit", 0.5f, 0.5f, 1f, 1f, 1f, 0f),
    )
    val incoming = outgoing.copy(id = "incoming", uri = "content://incoming",
      timelineStartMs = 4_000, timelineEndMs = 8_000, transitionType = "none", transitionDurationMs = 0)
    return Triple(outgoing, incoming, TimelineTransitionTimeline.create(listOf(outgoing, incoming),
      mapOf(outgoing.uri to 4_000L, incoming.uri to 4_000L)))
  }
}
