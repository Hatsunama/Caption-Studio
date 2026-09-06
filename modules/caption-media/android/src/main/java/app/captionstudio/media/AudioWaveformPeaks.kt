package app.captionstudio.media

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** Pure peak-bucketing helpers for timeline waveform visualization. */
internal object AudioWaveformPeaks {
  const val DEFAULT_PEAK_COUNT = 64
  const val MIN_PEAK_COUNT = 8
  const val MAX_PEAK_COUNT = 256

  fun clampPeakCount(peakCount: Int): Int {
    return peakCount.coerceIn(MIN_PEAK_COUNT, MAX_PEAK_COUNT)
  }

  fun sampleAmplitude(sample: Short): Float {
    return abs(sample.toInt()).toFloat() / Short.MAX_VALUE.toFloat()
  }

  /**
   * Downsample a dense per-sample (or per-frame) amplitude envelope into [peakCount] display peaks.
   * Each output value is the max amplitude in its source window, clamped to 0..1.
   */
  fun bucketPeaks(sampleAmplitudes: FloatArray, peakCount: Int): List<Double> {
    val count = clampPeakCount(peakCount)
    if (sampleAmplitudes.isEmpty()) {
      return List(count) { 0.0 }
    }
    val peaks = DoubleArray(count)
    val length = sampleAmplitudes.size.toDouble()
    for (index in sampleAmplitudes.indices) {
      val bucket = min(count - 1, ((index + 0.5) * count / length).toInt())
      peaks[bucket] = max(peaks[bucket], sampleAmplitudes[index].toDouble().coerceIn(0.0, 1.0))
    }
    return peaks.toList()
  }

  /** Running max accumulator used while decoding PCM without retaining every sample. */
  fun accumulateBucket(
    peaks: FloatArray,
    sampleIndex: Long,
    totalSamplesHint: Long,
    amplitude: Float,
  ) {
    if (peaks.isEmpty() || sampleIndex < 0L) return
    val total = max(1L, totalSamplesHint)
    val bucket = min(peaks.size - 1, ((sampleIndex * peaks.size) / total).toInt())
    peaks[bucket] = max(peaks[bucket], amplitude.coerceIn(0f, 1f))
  }
}
