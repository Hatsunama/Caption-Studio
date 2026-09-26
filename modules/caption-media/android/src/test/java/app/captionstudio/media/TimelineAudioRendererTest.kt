package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TimelineAudioRendererTest {
  private fun segment(id: String, volume: Float = 1f) = TimelineAudioSegment(
    id, "content://$id", 0, 1_000, 0, 1_000, 1f, volume, false,
  )

  @Test
  fun audibleMixAppliesEachSegmentVolume() {
    val gain = TimelineAudioGainProvider(0.35f)
    assertEquals(0.35f, gain.getGainFactorAtSamplePosition(0, 48_000), 0.0001f)
    assertEquals(0.35f, gain.getGainFactorAtSamplePosition(24_000, 48_000), 0.0001f)
  }

  @Test
  fun unreadableAudibleSourceFailsEvenWhenAnotherSourceIsUsable() {
    val plan = TimelineAudioPlan(1_000, listOf(segment("good")), listOf(segment("unreadable")))
    val error = assertThrows(IllegalStateException::class.java) {
      selectAudibleTimelineSegments(plan) { uri ->
        if (uri == "content://unreadable") throw SecurityException("grant revoked")
        true
      }
    }
    assertTrue(error.message.orEmpty().contains("unreadable"))
  }

  @Test
  fun silentVideoIsSkippedButSilentInsertedAudioFails() {
    val videoOnly = TimelineAudioPlan(1_000, listOf(segment("silent-video"), segment("good")), emptyList())
    assertEquals(listOf("good"), selectAudibleTimelineSegments(videoOnly) { it == "content://good" }.map { it.id })
    val inserted = TimelineAudioPlan(1_000, emptyList(), listOf(segment("silent-inserted")))
    assertThrows(IllegalStateException::class.java) { selectAudibleTimelineSegments(inserted) { false } }
  }
}
