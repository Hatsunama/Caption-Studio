package app.captionstudio.media

import kotlin.math.max
import kotlin.math.min

internal object AudioWaveformPeaks {
  const val DEFAULT_PEAK_COUNT = 512
  const val MIN_PEAK_COUNT = 32
  const val MAX_PEAK_COUNT = 4_096

  fun clampPeakCount(peakCount: Int): Int {
    return peakCount.coerceIn(MIN_PEAK_COUNT, MAX_PEAK_COUNT)
  }

  fun sampleAmplitude(sample: Short): Float {
    return kotlin.math.abs(sample.toInt().toDouble()).toFloat() / Short.MAX_VALUE.toFloat()
  }

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

  fun accumulateTimeBucket(
    peaks: FloatArray,
    presentationTimeUs: Long,
    durationUs: Long,
    amplitude: Float,
  ) {
    if (peaks.isEmpty() || presentationTimeUs < 0L) return
    val duration = max(1L, durationUs)
    val bucket = min(peaks.size - 1, ((presentationTimeUs * peaks.size) / duration).toInt())
    peaks[bucket] = max(peaks[bucket], amplitude.coerceIn(0f, 1f))
  }
}
