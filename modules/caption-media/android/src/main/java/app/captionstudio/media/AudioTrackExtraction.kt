package app.captionstudio.media

import kotlin.math.max

/** Pure helpers for lossless audio remux / duration selection used by CaptionMediaModule. */
internal object AudioTrackExtraction {
  const val AAC_MIME = "audio/mp4a-latm"
  const val OUTPUT_MIME = "audio/mp4"
  const val AAC_BIT_RATE = 128_000
  private const val TYPICAL_AAC_FRAME_US = 23_220L

  fun shouldCopyRemuxSample(sampleFlags: Int, codecConfigFlag: Int): Boolean {
    return sampleFlags and codecConfigFlag == 0
  }

  fun isLosslessMpeg4AudioMime(mime: String): Boolean {
    return mime.lowercase() == AAC_MIME
  }

  fun resolveExtractedDurationMs(
    declaredDurationUs: Long,
    lastPresentationUs: Long,
    probedDurationMs: Long,
  ): Long {
    if (probedDurationMs > 0L) return probedDurationMs
    if (declaredDurationUs > 0L) return max(1L, declaredDurationUs / 1_000L)
    // lastPresentationUs is the start of the final sample; add one typical AAC frame so
    // timeline length is not short by roughly one packet when KEY_DURATION is missing.
    return max(1L, (lastPresentationUs + TYPICAL_AAC_FRAME_US) / 1_000L)
  }
}
