package app.captionstudio.media

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Matrix
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.net.Uri
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import kotlin.math.max
import kotlin.math.roundToInt

class CaptionMediaModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("CaptionMedia")

    AsyncFunction("persistReadPermission") { inputUri: String ->
      persistReadPermission(inputUri)
    }

    AsyncFunction("sha256") { inputUri: String ->
      sha256(inputUri)
    }

    AsyncFunction("getMediaInfo") { inputUri: String ->
      readMediaInfo(inputUri)
    }

    AsyncFunction("extractAudioToWav") { inputUri: String, outputUri: String ->
      decodeAudioToWav(inputUri, outputUri)
    }

    AsyncFunction("extractAudioTrack") { inputUri: String, outputUri: String ->
      extractAudioTrack(inputUri, outputUri)
    }

    AsyncFunction("generateVideoThumbnail") { inputUri: String, outputUri: String, timeMs: Long ->
      generateVideoThumbnail(inputUri, outputUri, timeMs)
    }
  }

  private fun persistReadPermission(input: String): Boolean {
    val uri = Uri.parse(input)
    if (uri.scheme != "content") return true
    context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
    return true
  }

  private fun sha256(input: String): String {
    val uri = Uri.parse(input)
    val stream = if (uri.scheme.isNullOrEmpty() || uri.scheme == "file") {
      File(uri.path ?: input).inputStream()
    } else {
      context.contentResolver.openInputStream(uri)
        ?: throw IllegalArgumentException("The selected file could not be opened")
    }
    val digest = MessageDigest.getInstance("SHA-256")
    stream.use { source ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = source.read(buffer)
        if (count < 0) break
        if (count > 0) digest.update(buffer, 0, count)
      }
    }
    return digest.digest().joinToString("") { byte -> "%02x".format(byte) }
  }

  private fun generateVideoThumbnail(input: String, output: String, timeMs: Long): Map<String, Any> {
    val retriever = MediaMetadataRetriever()
    val targetFile = outputFile(output)
    var frame: Bitmap? = null
    var orientedFrame: Bitmap? = null
    var completed = false
    return try {
      setRetrieverDataSource(retriever, input)
      val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
      val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      val target = thumbnailSize(width, height)
      frame = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1 && target.first > 0 && target.second > 0) {
        retriever.getScaledFrameAtTime(
          max(0L, timeMs) * 1_000L,
          MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
          target.first,
          target.second,
        )
      } else {
        retriever.getFrameAtTime(max(0L, timeMs) * 1_000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
      }
      val decoded = frame ?: retriever.frameAtTime
        ?: throw IllegalArgumentException("The first video frame could not be decoded")
      orientedFrame = if (rotation % 360 == 0) {
        decoded
      } else {
        val matrix = Matrix().apply { postRotate(rotation.toFloat()) }
        Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
      }

      val renderedFrame = requireNotNull(orientedFrame)
      targetFile.parentFile?.mkdirs()
      FileOutputStream(targetFile).use { stream ->
        check(renderedFrame.compress(Bitmap.CompressFormat.JPEG, 88, stream)) {
          "The first video frame could not be saved"
        }
      }
      completed = true
      mapOf(
        "outputUri" to output,
        "width" to renderedFrame.width,
        "height" to renderedFrame.height,
        "timeMs" to max(0L, timeMs),
      )
    } finally {
      if (orientedFrame !== frame) orientedFrame?.recycle()
      frame?.recycle()
      retriever.release()
      if (!completed) targetFile.delete()
    }
  }

  private fun thumbnailSize(width: Int, height: Int): Pair<Int, Int> {
    if (width <= 0 || height <= 0) return 0 to 0
    val scale = minOf(1.0, 640.0 / max(width, height).toDouble())
    return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
  }

  private fun readMediaInfo(input: String): Map<String, Any> {
    val retriever = MediaMetadataRetriever()
    val extractor = MediaExtractor()
    return try {
      setRetrieverDataSource(retriever, input)
      setExtractorDataSource(extractor, input)
      var hasAudio = false
      var fallbackDurationUs = 0L
      for (index in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(index)
        val mime = format.getString(MediaFormat.KEY_MIME).orEmpty()
        if (mime.startsWith("audio/")) hasAudio = true
        if (format.containsKey(MediaFormat.KEY_DURATION)) {
          fallbackDurationUs = max(fallbackDurationUs, format.getLong(MediaFormat.KEY_DURATION))
        }
      }
      val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        ?: fallbackDurationUs / 1_000L
      mapOf(
        "durationMs" to max(0L, durationMs),
        "width" to (retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0),
        "height" to (retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0),
        "rotation" to (retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0),
        "hasAudio" to hasAudio,
      )
    } finally {
      retriever.release()
      extractor.release()
    }
  }

  private fun decodeAudioToWav(input: String, output: String): Map<String, Any> {
    val extractor = MediaExtractor()
    val targetFile = outputFile(output)
    var decoder: MediaCodec? = null
    var writer: WavWriter? = null
    var completed = false
    return try {
      setExtractorDataSource(extractor, input)
      val audioTrack = (0 until extractor.trackCount).firstOrNull { index ->
        extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
      } ?: throw IllegalArgumentException("This video does not contain an audio track")

      extractor.selectTrack(audioTrack)
      val inputFormat = extractor.getTrackFormat(audioTrack)
      val mime = inputFormat.getString(MediaFormat.KEY_MIME)
        ?: throw IllegalArgumentException("The video audio format is missing")
      if (inputFormat.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
        inputFormat.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
      }

      decoder = MediaCodec.createDecoderByType(mime)
      decoder.configure(inputFormat, null, null, 0)
      decoder.start()

      targetFile.parentFile?.mkdirs()
      writer = WavWriter(targetFile, TARGET_SAMPLE_RATE, 1)

      val info = MediaCodec.BufferInfo()
      var inputEnded = false
      var outputEnded = false
      var sampleRate = inputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      var channelCount = inputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      var pcmEncoding = AudioFormat.ENCODING_PCM_16BIT
      var insertedSilenceSamples = 0L
      var trimmedOverlapSamples = 0L

      while (!outputEnded) {
        if (!inputEnded) {
          val inputIndex = decoder.dequeueInputBuffer(TIMEOUT_US)
          if (inputIndex >= 0) {
            val inputBuffer = decoder.getInputBuffer(inputIndex)
              ?: throw IllegalStateException("Audio decoder input buffer was unavailable")
            val sampleSize = extractor.readSampleData(inputBuffer, 0)
            if (sampleSize < 0) {
              decoder.queueInputBuffer(inputIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputEnded = true
            } else {
              decoder.queueInputBuffer(inputIndex, 0, sampleSize, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }

        when (val outputIndex = decoder.dequeueOutputBuffer(info, TIMEOUT_US)) {
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            val format = decoder.outputFormat
            sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            channelCount = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            pcmEncoding = if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
              format.getInteger(MediaFormat.KEY_PCM_ENCODING)
            } else {
              AudioFormat.ENCODING_PCM_16BIT
            }
          }
          MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
          else -> if (outputIndex >= 0) {
            if (info.size > 0) {
              val outputBuffer = decoder.getOutputBuffer(outputIndex)
                ?: throw IllegalStateException("Audio decoder output buffer was unavailable")
              outputBuffer.position(info.offset)
              outputBuffer.limit(info.offset + info.size)
              val mono = pcmToMono(outputBuffer.slice().order(ByteOrder.LITTLE_ENDIAN), pcmEncoding, channelCount)
              val targetStart = max(0L, info.presentationTimeUs * TARGET_SAMPLE_RATE / 1_000_000L)
              val targetEnd = targetStart + (mono.size.toLong() * TARGET_SAMPLE_RATE / max(1, sampleRate))
              if (targetStart > writer.sampleCount) {
                val gap = targetStart - writer.sampleCount
                writer.writeSilence(gap)
                insertedSilenceSamples += gap
              } else if (targetStart < writer.sampleCount) {
                trimmedOverlapSamples += minOf(writer.sampleCount - targetStart, max(0L, targetEnd - targetStart))
              }
              if (targetEnd > writer.sampleCount) {
                val firstOutputSample = writer.sampleCount
                val count = (targetEnd - firstOutputSample).toInt()
                val resampled = ShortArray(count)
                for (index in 0 until count) {
                  val absoluteOutput = firstOutputSample + index
                  val sourceFrame = ((absoluteOutput - targetStart) * sampleRate / TARGET_SAMPLE_RATE)
                    .coerceIn(0L, max(0, mono.lastIndex).toLong()).toInt()
                  resampled[index] = mono[sourceFrame]
                }
                writer.writeSamples(resampled)
              }
            }
            outputEnded = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
            decoder.releaseOutputBuffer(outputIndex, false)
          }
        }
      }

      writer.finish()
      val durationMs = writer.sampleCount * 1_000L / TARGET_SAMPLE_RATE
      completed = true
      mapOf(
        "outputUri" to output,
        "sampleRate" to TARGET_SAMPLE_RATE,
        "channelCount" to 1,
        "durationMs" to durationMs,
        "pcmBytes" to writer.sampleCount * 2L,
        "insertedSilenceMs" to insertedSilenceSamples * 1_000L / TARGET_SAMPLE_RATE,
        "trimmedOverlapMs" to trimmedOverlapSamples * 1_000L / TARGET_SAMPLE_RATE,
      )
    } finally {
      try {
        writer?.finish()
      } catch (_: Throwable) {
      }
      try {
        decoder?.stop()
      } catch (_: Throwable) {
      }
      decoder?.release()
      extractor.release()
      if (!completed) targetFile.delete()
    }
  }

  private fun extractAudioTrack(input: String, output: String): Map<String, Any> {
    val extractor = MediaExtractor()
    val targetFile = outputFile(output)
    var muxer: MediaMuxer? = null
    var completed = false
    return try {
      setExtractorDataSource(extractor, input)
      val audioTrack = (0 until extractor.trackCount).firstOrNull { index ->
        extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
      } ?: throw IllegalArgumentException("This video does not contain an audio track")
      val format = extractor.getTrackFormat(audioTrack)
      val trackMime = format.getString(MediaFormat.KEY_MIME)
        ?: throw IllegalArgumentException("The video audio format is missing")
      extractor.selectTrack(audioTrack)
      targetFile.parentFile?.mkdirs()
      if (targetFile.exists()) targetFile.delete()
      muxer = MediaMuxer(targetFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val outputTrack = muxer.addTrack(format)
      muxer.start()

      val maximumInputSize = if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
        max(256 * 1024, format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE))
      } else {
        1024 * 1024
      }
      val buffer = ByteBuffer.allocateDirect(maximumInputSize)
      val info = MediaCodec.BufferInfo()
      var firstPresentationUs = -1L
      var lastPresentationUs = 0L
      while (true) {
        buffer.clear()
        val sampleSize = extractor.readSampleData(buffer, 0)
        if (sampleSize < 0) break
        val presentationUs = extractor.sampleTime
        if (firstPresentationUs < 0) firstPresentationUs = presentationUs
        val normalizedPresentationUs = max(0L, presentationUs - firstPresentationUs)
        info.set(0, sampleSize, normalizedPresentationUs, extractor.sampleFlags)
        buffer.position(0)
        buffer.limit(sampleSize)
        muxer.writeSampleData(outputTrack, buffer, info)
        lastPresentationUs = normalizedPresentationUs
        extractor.advance()
      }
      require(firstPresentationUs >= 0) { "The video audio track did not contain readable samples" }
      muxer.stop()
      muxer.release()
      muxer = null
      completed = true
      mapOf(
        "outputUri" to output,
        "durationMs" to max(1L, lastPresentationUs / 1_000L),
        "mimeType" to "audio/mp4",
        "sourceCodec" to trackMime,
      )
    } catch (error: Throwable) {
      throw IllegalArgumentException("This audio track could not be imported without losing quality: ${error.message}", error)
    } finally {
      try {
        muxer?.stop()
      } catch (_: Throwable) {
      }
      try {
        muxer?.release()
      } catch (_: Throwable) {
      }
      extractor.release()
      if (!completed) targetFile.delete()
    }
  }

  private fun pcmToMono(buffer: ByteBuffer, encoding: Int, channels: Int): ShortArray {
    val channelCount = max(1, channels)
    val bytesPerSample = if (encoding == AudioFormat.ENCODING_PCM_FLOAT) 4 else 2
    val frames = buffer.remaining() / bytesPerSample / channelCount
    val output = ShortArray(frames)
    for (frame in 0 until frames) {
      var sum = 0.0
      for (channel in 0 until channelCount) {
        sum += if (encoding == AudioFormat.ENCODING_PCM_FLOAT) {
          (buffer.float.coerceIn(-1f, 1f) * Short.MAX_VALUE).toDouble()
        } else {
          buffer.short.toDouble()
        }
      }
      output[frame] = (sum / channelCount).roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
    }
    return output
  }

  private fun setRetrieverDataSource(retriever: MediaMetadataRetriever, input: String) {
    val uri = Uri.parse(input)
    if (uri.scheme.isNullOrEmpty() || uri.scheme == "file") retriever.setDataSource(uri.path ?: input)
    else retriever.setDataSource(context, uri)
  }

  private fun setExtractorDataSource(extractor: MediaExtractor, input: String) {
    val uri = Uri.parse(input)
    if (uri.scheme.isNullOrEmpty() || uri.scheme == "file") extractor.setDataSource(uri.path ?: input)
    else extractor.setDataSource(context, uri, null)
  }

  private fun outputFile(output: String): File {
    val uri = Uri.parse(output)
    require(uri.scheme.isNullOrEmpty() || uri.scheme == "file") { "Output must be an app-local file URI" }
    return File(uri.path ?: output)
  }

  companion object {
    private const val TARGET_SAMPLE_RATE = 16_000
    private const val TIMEOUT_US = 10_000L
  }
}

private class WavWriter(file: File, private val sampleRate: Int, private val channels: Int) {
  private val stream = RandomAccessFile(file, "rw")
  var sampleCount = 0L
    private set
  private var finished = false

  init {
    stream.setLength(0)
    stream.write(ByteArray(44))
  }

  fun writeSamples(samples: ShortArray) {
    val bytes = ByteBuffer.allocate(samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
    samples.forEach(bytes::putShort)
    stream.write(bytes.array())
    sampleCount += samples.size
  }

  fun writeSilence(samples: Long) {
    var remaining = samples
    val zeros = ByteArray(16_384)
    while (remaining > 0) {
      val bytes = minOf(remaining * 2L, zeros.size.toLong()).toInt()
      stream.write(zeros, 0, bytes)
      val writtenSamples = bytes / 2
      sampleCount += writtenSamples
      remaining -= writtenSamples
    }
  }

  fun finish() {
    if (finished) return
    finished = true
    val dataBytes = sampleCount * channels * 2L
    stream.seek(0)
    stream.writeBytes("RIFF")
    stream.writeLittleEndianInt((36L + dataBytes).coerceAtMost(0xFFFF_FFFFL).toInt())
    stream.writeBytes("WAVEfmt ")
    stream.writeLittleEndianInt(16)
    stream.writeLittleEndianShort(1)
    stream.writeLittleEndianShort(channels)
    stream.writeLittleEndianInt(sampleRate)
    stream.writeLittleEndianInt(sampleRate * channels * 2)
    stream.writeLittleEndianShort(channels * 2)
    stream.writeLittleEndianShort(16)
    stream.writeBytes("data")
    stream.writeLittleEndianInt(dataBytes.coerceAtMost(0xFFFF_FFFFL).toInt())
    stream.close()
  }
}

private fun RandomAccessFile.writeLittleEndianInt(value: Int) {
  writeInt(Integer.reverseBytes(value))
}

private fun RandomAccessFile.writeLittleEndianShort(value: Int) {
  writeShort(java.lang.Short.reverseBytes(value.toShort()).toInt())
}
