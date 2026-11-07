package app.captionstudio.media

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.decoder.DecoderInputBuffer
import androidx.media3.exoplayer.FormatHolder
import androidx.media3.exoplayer.source.SampleQueue
import androidx.media3.exoplayer.upstream.DefaultAllocator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * PRIVATE DIAGNOSTIC: actual Media3 queue behavior, deliberately RED on 1.10.1.
 *
 * The one-byte payloads are opaque queue data, not valid AVC. The reference/B labels describe
 * decode-order timestamps only. This proves sample availability at the queue boundary, NOT GPU,
 * MediaCodec, Transformer, preview, or exported-frame correctness.
 *
 * API/behavior checked against the official version-pinned sources:
 * https://github.com/androidx/media/blob/1.10.1/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/source/SampleQueue.java
 * https://github.com/androidx/media/blob/1.11.0/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/source/SampleQueue.java
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class TimelineReorderedClippingTest {
  @Test
  fun endClippingKeepsInRangeBFrameAfterFutureReference() {
    val decodeOrder = listOf(0L, PREFIX_US, FUTURE_REFERENCE_US, RETAINED_B_US) + trailingSamples()
    val actual = readToEos(decodeOrder, TRIM_END_US)

    assertTrue(
      "End $TRIM_END_US must retain B-frame $RETAINED_B_US after reference " +
        "$FUTURE_REFERENCE_US; actual queue timestamps: $actual. " +
        "Media3 1.10.1 fixes its end index at the first crossing and returns EOS before this B-frame.",
      RETAINED_B_US in actual,
    )
    // The out-of-range reference must remain available for decoding the later in-range B-frame.
    // SampleQueue preserves decode order; a strict-duration renderer owns output suppression.
    assertEquals(listOf(0L, PREFIX_US, FUTURE_REFERENCE_US, RETAINED_B_US), actual)
  }

  @Test
  fun monotonicSamplesStopAtExclusiveEnd() {
    val inRange = listOf(0L, PREFIX_US, RETAINED_B_US)
    val decodeOrder = inRange + trailingSamples()
    assertEquals(inRange, readToEos(decodeOrder, TRIM_END_US))
  }

  @Test
  fun allSamplesBeforeEndSurviveReorderingAndLastSampleSignalsEos() {
    val decodeOrder = listOf(0L, RETAINED_B_US, PREFIX_US)
    // loadingFinished stays false: BUFFER_FLAG_LAST_SAMPLE alone must terminate the read.
    assertEquals(decodeOrder, readToEos(decodeOrder, TRIM_END_US))
  }

  @Test
  fun unboundedReadPreservesDecodeOrderAndLoadingFinishedSignalsEos() {
    val decodeOrder = listOf(0L, PREFIX_US, FUTURE_REFERENCE_US, RETAINED_B_US)
    // No clipping and no LAST_SAMPLE: exercise actual EOF through read's loadingFinished API.
    assertEquals(
      decodeOrder,
      readToEos(decodeOrder, C.TIME_END_OF_SOURCE, markLastSample = false, loadingFinished = true),
    )
  }

  private fun trailingSamples(): List<Long> =
    // 1.11 uses an unknown-reorder upper bound of 16, requiring 17 consecutive >= end samples.
    // Begin exactly at the exclusive end, after the B-frame has reset the crossing candidate.
    // Do not set the new Format.maxNumReorderSamples field: it does not exist in 1.10.1.
    List(17) { TRIM_END_US + it * 41_667L }

  private fun readToEos(
    decodeOrder: List<Long>,
    endTimeUs: Long,
    markLastSample: Boolean = true,
    loadingFinished: Boolean = false,
  ): List<Long> {
    val queue = SampleQueue.createWithoutDrm(DefaultAllocator(true, 32))
    try {
      queue.format(Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).build())
      queue.setReadEndTimeUs(endTimeUs)
      decodeOrder.forEachIndexed { index, timeUs ->
        // Only the initial sample is a keyframe; a future keyframe would settle 1.11's end early.
        var flags = if (index == 0) C.BUFFER_FLAG_KEY_FRAME else 0
        if (markLastSample && index == decodeOrder.lastIndex) {
          flags = flags or C.BUFFER_FLAG_LAST_SAMPLE
        }
        queue.sampleData(ParsableByteArray(byteArrayOf(index.toByte())), 1)
        queue.sampleMetadata(timeUs, flags, 1, 0, null)
      }

      val holder = FormatHolder()
      val buffer = DecoderInputBuffer(DecoderInputBuffer.BUFFER_REPLACEMENT_MODE_NORMAL)
      val timestamps = mutableListOf<Long>()
      var formatRead = false
      // One format, at most N samples, then EOS. Never spin on NOTHING_READ.
      repeat(decodeOrder.size + 2) {
        buffer.clear()
        when (val result = queue.read(holder, buffer, 0, loadingFinished)) {
          C.RESULT_FORMAT_READ -> {
            assertEquals(MimeTypes.VIDEO_H264, holder.format?.sampleMimeType)
            formatRead = true
          }
          C.RESULT_BUFFER_READ -> {
            if (buffer.isEndOfStream) {
              assertTrue("Expected format before EOS", formatRead)
              return timestamps
            }
            assertTrue("Expected format before sample", formatRead)
            buffer.flip()
            val data = requireNotNull(buffer.data)
            assertEquals("Read actual one-byte payload", 1, data.remaining())
            assertEquals("Payload stays in decode order", timestamps.size.toByte(), data.get())
            timestamps.add(buffer.timeUs)
          }
          else -> throw AssertionError("Unexpected read result $result before EOS: $timestamps")
        }
      }
      throw AssertionError("No EOS within ${decodeOrder.size + 2} reads: $timestamps")
    } finally {
      queue.release()
    }
  }

  private companion object {
    const val PREFIX_US = 6_333_333L
    const val FUTURE_REFERENCE_US = 6_416_667L
    const val RETAINED_B_US = 6_375_000L
    const val TRIM_END_US = 6_385_000L
  }
}
