package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioWaveformPeaksTest {
  @Test
  fun clampsPeakCount() {
    assertEquals(32, AudioWaveformPeaks.clampPeakCount(1))
    assertEquals(512, AudioWaveformPeaks.clampPeakCount(512))
    assertEquals(4_096, AudioWaveformPeaks.clampPeakCount(10_000))
  }

  @Test
  fun bucketsPreferLoudestSampleInWindow() {
    val dense = FloatArray(100) { index -> if (index == 55) 0.9f else 0.1f }
    val peaks = AudioWaveformPeaks.bucketPeaks(dense, 10)
    assertEquals(32, peaks.size)
    assertTrue(peaks[17] >= 0.89)
    assertTrue(peaks.all { it in 0.0..1.0 })
  }

  @Test
  fun emptyInputYieldsSilentPeaks() {
    val peaks = AudioWaveformPeaks.bucketPeaks(FloatArray(0), 16)
    assertEquals(32, peaks.size)
    assertTrue(peaks.all { it == 0.0 })
  }

  @Test
  fun timedBucketsTrackTheWholeSourceAtAnySampleRate() {
    val peaks = FloatArray(4)
    AudioWaveformPeaks.accumulateTimeBucket(peaks, 100_000, 10_000_000, 0.2f)
    AudioWaveformPeaks.accumulateTimeBucket(peaks, 2_900_000, 10_000_000, 0.8f)
    AudioWaveformPeaks.accumulateTimeBucket(peaks, 9_000_000, 10_000_000, 0.6f)
    assertEquals(0.2f, peaks[0], 0.001f)
    assertEquals(0.8f, peaks[1], 0.001f)
    assertEquals(0.6f, peaks[3], 0.001f)
  }
}
