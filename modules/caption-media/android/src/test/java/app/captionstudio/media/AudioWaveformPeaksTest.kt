package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioWaveformPeaksTest {
  @Test
  fun clampsPeakCount() {
    assertEquals(8, AudioWaveformPeaks.clampPeakCount(1))
    assertEquals(64, AudioWaveformPeaks.clampPeakCount(64))
    assertEquals(256, AudioWaveformPeaks.clampPeakCount(10_000))
  }

  @Test
  fun bucketsPreferLoudestSampleInWindow() {
    val dense = FloatArray(100) { index -> if (index == 55) 0.9f else 0.1f }
    val peaks = AudioWaveformPeaks.bucketPeaks(dense, 10)
    assertEquals(10, peaks.size)
    assertTrue(peaks[5] >= 0.89)
    assertTrue(peaks.all { it in 0.0..1.0 })
  }

  @Test
  fun emptyInputYieldsSilentPeaks() {
    val peaks = AudioWaveformPeaks.bucketPeaks(FloatArray(0), 16)
    assertEquals(16, peaks.size)
    assertTrue(peaks.all { it == 0.0 })
  }

  @Test
  fun accumulateBucketTracksRunningMax() {
    val peaks = FloatArray(4)
    AudioWaveformPeaks.accumulateBucket(peaks, 0, 100, 0.2f)
    AudioWaveformPeaks.accumulateBucket(peaks, 10, 100, 0.8f)
    AudioWaveformPeaks.accumulateBucket(peaks, 11, 100, 0.4f)
    assertEquals(0.8f, peaks[0], 0.001f)
  }
}
