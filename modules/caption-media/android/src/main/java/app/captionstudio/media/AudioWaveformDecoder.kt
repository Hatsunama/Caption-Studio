package app.captionstudio.media

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.max

internal class AudioWaveformDecoder(private val context: Context) {
  fun generate(inputUri: String, requestedPeakCount: Int): Map<String, Any> {
    val extractor = MediaExtractor()
    var decoder: MediaCodec? = null

    try {
      setExtractorSource(extractor, inputUri)
      val trackIndex = (0 until extractor.trackCount).firstOrNull { index ->
        extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
      } ?: throw IllegalArgumentException("The selected file does not contain an audio track.")

      extractor.selectTrack(trackIndex)
      val inputFormat = extractor.getTrackFormat(trackIndex)
      val mime = inputFormat.getString(MediaFormat.KEY_MIME)
        ?: throw IllegalArgumentException("The audio track format is unavailable.")
      val durationUs = resolveDurationUs(inputFormat, inputUri)
      if (durationUs <= 0L) {
        throw IllegalArgumentException("The audio track duration is unavailable.")
      }

      val peaks = FloatArray(AudioWaveformPeaks.clampPeakCount(requestedPeakCount))
      val activeDecoder = MediaCodec.createDecoderByType(mime)
      decoder = activeDecoder
      activeDecoder.configure(inputFormat, null, null, 0)
      activeDecoder.start()

      val bufferInfo = MediaCodec.BufferInfo()
      var inputEnded = false
      var outputEnded = false
      var outputFormat = inputFormat

      while (!outputEnded) {
        if (!inputEnded) {
          val inputIndex = activeDecoder.dequeueInputBuffer(CODEC_TIMEOUT_US)
          if (inputIndex >= 0) {
            val inputBuffer = activeDecoder.getInputBuffer(inputIndex)
              ?: throw IllegalStateException("The audio decoder input buffer is unavailable.")
            inputBuffer.clear()
            val sampleSize = extractor.readSampleData(inputBuffer, 0)
            if (sampleSize < 0) {
              activeDecoder.queueInputBuffer(
                inputIndex,
                0,
                0,
                0,
                MediaCodec.BUFFER_FLAG_END_OF_STREAM,
              )
              inputEnded = true
            } else {
              activeDecoder.queueInputBuffer(
                inputIndex,
                0,
                sampleSize,
                extractor.sampleTime.coerceAtLeast(0L),
                0,
              )
              extractor.advance()
            }
          }
        }

        when (val outputIndex = activeDecoder.dequeueOutputBuffer(bufferInfo, CODEC_TIMEOUT_US)) {
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> outputFormat = activeDecoder.outputFormat
          MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
          else -> if (outputIndex >= 0) {
            if (bufferInfo.size > 0) {
              val outputBuffer = activeDecoder.getOutputBuffer(outputIndex)
                ?: throw IllegalStateException("The audio decoder output buffer is unavailable.")
              accumulateOutput(outputBuffer, bufferInfo, outputFormat, durationUs, peaks)
            }
            outputEnded = bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
            activeDecoder.releaseOutputBuffer(outputIndex, false)
          }
        }
      }

      val maximum = peaks.maxOrNull()?.coerceAtLeast(MIN_VISIBLE_PEAK) ?: MIN_VISIBLE_PEAK
      val normalized = if (maximum <= MIN_VISIBLE_PEAK) {
        peaks.map { 0.0 }
      } else {
        peaks.map { (it / maximum).coerceIn(0f, 1f).toDouble() }
      }

      return mapOf(
        "durationMs" to max(1L, durationUs / 1_000L),
        "peaks" to normalized,
      )
    } finally {
      runCatching { decoder?.stop() }
      runCatching { decoder?.release() }
      runCatching { extractor.release() }
    }
  }

  private fun accumulateOutput(
    outputBuffer: ByteBuffer,
    info: MediaCodec.BufferInfo,
    format: MediaFormat,
    durationUs: Long,
    peaks: FloatArray,
  ) {
    val sampleRate = format.integerOrNull(MediaFormat.KEY_SAMPLE_RATE)?.coerceAtLeast(1) ?: 44_100
    val channelCount = format.integerOrNull(MediaFormat.KEY_CHANNEL_COUNT)?.coerceAtLeast(1) ?: 1
    val encoding = format.integerOrNull(MediaFormat.KEY_PCM_ENCODING) ?: AudioFormat.ENCODING_PCM_16BIT
    val bytesPerSample = when (encoding) {
      AudioFormat.ENCODING_PCM_8BIT -> 1
      AudioFormat.ENCODING_PCM_16BIT -> 2
      AudioFormat.ENCODING_PCM_24BIT_PACKED -> 3
      AudioFormat.ENCODING_PCM_32BIT, AudioFormat.ENCODING_PCM_FLOAT -> 4
      else -> throw IllegalArgumentException("The decoded audio sample format is unsupported.")
    }
    val bytesPerFrame = bytesPerSample * channelCount
    if (bytesPerFrame <= 0 || info.size < bytesPerFrame) return

    val pcm = outputBuffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)
    pcm.position(info.offset)
    pcm.limit(info.offset + info.size)
    val samples = pcm.slice().order(ByteOrder.LITTLE_ENDIAN)
    val frameCount = samples.remaining() / bytesPerFrame

    repeat(frameCount) { frameIndex ->
      var amplitude = 0f
      repeat(channelCount) {
        amplitude = max(amplitude, readAmplitude(samples, encoding))
      }
      val presentationTimeUs = info.presentationTimeUs +
        (frameIndex.toLong() * 1_000_000L / sampleRate.toLong())
      AudioWaveformPeaks.accumulateTimeBucket(peaks, presentationTimeUs, durationUs, amplitude)
    }
  }

  private fun readAmplitude(buffer: ByteBuffer, encoding: Int): Float = when (encoding) {
    AudioFormat.ENCODING_PCM_8BIT -> abs(((buffer.get().toInt() and 0xff) - 128) / 128f)
    AudioFormat.ENCODING_PCM_16BIT -> abs(buffer.short.toInt() / 32_768f)
    AudioFormat.ENCODING_PCM_24BIT_PACKED -> {
      val raw = (buffer.get().toInt() and 0xff) or
        ((buffer.get().toInt() and 0xff) shl 8) or
        ((buffer.get().toInt() and 0xff) shl 16)
      val signed = if (raw and 0x0080_0000 != 0) raw or -0x0100_0000 else raw
      abs(signed / 8_388_608f)
    }
    AudioFormat.ENCODING_PCM_32BIT -> abs(buffer.int / 2_147_483_648f)
    AudioFormat.ENCODING_PCM_FLOAT -> abs(buffer.float).takeIf { it.isFinite() }?.coerceAtMost(1f) ?: 0f
    else -> 0f
  }

  private fun resolveDurationUs(format: MediaFormat, inputUri: String): Long {
    val formatDuration = format.longOrNull(MediaFormat.KEY_DURATION) ?: 0L
    if (formatDuration > 0L) return formatDuration

    val retriever = MediaMetadataRetriever()
    return try {
      setRetrieverSource(retriever, inputUri)
      val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
        ?.toLongOrNull()
        ?: 0L
      durationMs * 1_000L
    } finally {
      runCatching { retriever.release() }
    }
  }

  private fun setExtractorSource(extractor: MediaExtractor, inputUri: String) {
    val uri = Uri.parse(inputUri)
    when (uri.scheme?.lowercase()) {
      "content" -> context.contentResolver.openFileDescriptor(uri, "r")?.use { descriptor ->
        extractor.setDataSource(descriptor.fileDescriptor)
      } ?: throw IllegalArgumentException("The selected audio file cannot be opened.")
      "file" -> extractor.setDataSource(
        uri.path ?: throw IllegalArgumentException("The selected audio file path is invalid."),
      )
      else -> extractor.setDataSource(inputUri)
    }
  }

  private fun setRetrieverSource(retriever: MediaMetadataRetriever, inputUri: String) {
    val uri = Uri.parse(inputUri)
    when (uri.scheme?.lowercase()) {
      "content" -> retriever.setDataSource(context, uri)
      "file" -> retriever.setDataSource(
        uri.path ?: throw IllegalArgumentException("The selected audio file path is invalid."),
      )
      else -> retriever.setDataSource(inputUri)
    }
  }

  private fun MediaFormat.integerOrNull(key: String): Int? =
    if (containsKey(key)) runCatching { getInteger(key) }.getOrNull() else null

  private fun MediaFormat.longOrNull(key: String): Long? =
    if (containsKey(key)) runCatching { getLong(key) }.getOrNull() else null

  private companion object {
    const val CODEC_TIMEOUT_US = 10_000L
    const val MIN_VISIBLE_PEAK = 0.000_001f
  }
}
