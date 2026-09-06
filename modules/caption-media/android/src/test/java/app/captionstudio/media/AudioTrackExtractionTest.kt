package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioTrackExtractionTest {
  @Test
  fun skipsCodecConfigSamplesDuringRemux() {
    val codecConfig = 2 // MediaCodec.BUFFER_FLAG_CODEC_CONFIG
    assertFalse(AudioTrackExtraction.shouldCopyRemuxSample(codecConfig, codecConfig))
    assertFalse(AudioTrackExtraction.shouldCopyRemuxSample(codecConfig or 1, codecConfig))
    assertTrue(AudioTrackExtraction.shouldCopyRemuxSample(1, codecConfig))
    assertTrue(AudioTrackExtraction.shouldCopyRemuxSample(0, codecConfig))
  }

  @Test
  fun prefersProbedThenDeclaredDurationOverLastSamplePts() {
    assertEquals(
      12_500L,
      AudioTrackExtraction.resolveExtractedDurationMs(
        declaredDurationUs = 10_000_000L,
        lastPresentationUs = 9_900_000L,
        probedDurationMs = 12_500L,
      ),
    )
    assertEquals(
      10_000L,
      AudioTrackExtraction.resolveExtractedDurationMs(
        declaredDurationUs = 10_000_000L,
        lastPresentationUs = 9_900_000L,
        probedDurationMs = 0L,
      ),
    )
    assertEquals(
      9_923L,
      AudioTrackExtraction.resolveExtractedDurationMs(
        declaredDurationUs = 0L,
        lastPresentationUs = 9_900_000L,
        probedDurationMs = 0L,
      ),
    )
  }

  @Test
  fun recognizesLosslessMpeg4AudioMime() {
    assertTrue(AudioTrackExtraction.isLosslessMpeg4AudioMime("audio/mp4a-latm"))
    assertFalse(AudioTrackExtraction.isLosslessMpeg4AudioMime("audio/mpeg"))
    assertFalse(AudioTrackExtraction.isLosslessMpeg4AudioMime("audio/opus"))
    assertFalse(AudioTrackExtraction.isLosslessMpeg4AudioMime("audio/raw"))
  }
}
