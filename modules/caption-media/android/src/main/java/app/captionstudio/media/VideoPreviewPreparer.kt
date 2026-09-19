package app.captionstudio.media

import android.content.Context
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import expo.modules.kotlin.Promise
import java.io.File

@OptIn(UnstableApi::class)
internal class VideoPreviewPreparer(private val context: Context) {
  private val handler = Handler(Looper.getMainLooper())
  private var active: ActivePreview? = null

  fun support(inputUri: String): Map<String, Any?> {
    val format = videoFormat(inputUri)
    val mime = format.getString(MediaFormat.KEY_MIME)
      ?: throw IllegalArgumentException("The video track has no codec type")
    val width = format.getInteger(MediaFormat.KEY_WIDTH)
    val height = format.getInteger(MediaFormat.KEY_HEIGHT)
    val frameRate = if (format.containsKey(MediaFormat.KEY_FRAME_RATE)) {
      try {
        format.getFloat(MediaFormat.KEY_FRAME_RATE).toDouble()
      } catch (_: ClassCastException) {
        format.getInteger(MediaFormat.KEY_FRAME_RATE).toDouble()
      }
    } else {
      30.0
    }
    val decoder = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.firstOrNull { info ->
      if (info.isEncoder || info.supportedTypes.none { it.equals(mime, ignoreCase = true) }) return@firstOrNull false
      try {
        val capabilities = info.getCapabilitiesForType(mime)
        capabilities.isFormatSupported(format)
          && capabilities.videoCapabilities?.areSizeAndRateSupported(width, height, frameRate) == true
      } catch (_: Throwable) {
        false
      }
    }
    return mapOf(
      "supported" to (decoder != null),
      "decoderName" to decoder?.name,
      "reason" to if (decoder == null) "This phone cannot sustain the source video's codec, size, and frame rate for editing." else null,
      "width" to width,
      "height" to height,
      "frameRate" to frameRate,
      "mimeType" to mime,
    )
  }

  fun prepare(inputUri: String, outputUri: String, width: Int, height: Int, frameRate: Int, promise: Promise) {
    handler.post {
      if (active != null) {
        promise.reject("E_VIDEO_PREVIEW_BUSY", "Another video is already being optimized for editing", null)
        return@post
      }
      val output = outputFile(outputUri)
      try {
        require(width > 0 && height > 0 && width % 2 == 0 && height % 2 == 0) { "Preview dimensions must be positive even numbers" }
        require(frameRate in 1..30) { "Preview frame rate must be between 1 and 30" }
        output.parentFile?.mkdirs()
        if (output.exists() && !output.delete()) throw IllegalStateException("The previous preview could not be replaced")
        val edited = EditedMediaItem.Builder(MediaItem.fromUri(Uri.parse(inputUri)))
          .setEffects(Effects(emptyList(), listOf(
            Presentation.createForWidthAndHeight(width, height, Presentation.LAYOUT_SCALE_TO_FIT),
            FrameDropEffect.createDefaultFrameDropEffect(frameRate.toFloat()),
          )))
          .build()
        lateinit var transformer: Transformer
        transformer = Transformer.Builder(context.applicationContext)
          .setLooper(Looper.getMainLooper())
          .setVideoMimeType(MimeTypes.VIDEO_H264)
          .setAudioMimeType(MimeTypes.AUDIO_AAC)
          .addListener(object : Transformer.Listener {
            override fun onCompleted(composition: Composition, exportResult: ExportResult) {
              val task = claim(transformer) ?: return
              val size = task.output.takeIf { it.isFile }?.length() ?: 0L
              if (size <= 0L) {
                task.output.delete()
                task.promise.reject("E_VIDEO_PREVIEW_EMPTY", "The optimized editing preview was empty", null)
                return
              }
              task.promise.resolve(mapOf("outputUri" to Uri.fromFile(task.output).toString(), "sizeBytes" to size.toDouble()))
            }

            override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
              val task = claim(transformer) ?: return
              task.output.delete()
              task.promise.reject("E_VIDEO_PREVIEW", "Caption Studio could not optimize this video for smooth editing", exportException)
            }
          })
          .build()
        active = ActivePreview(transformer, output, promise)
        transformer.start(edited, output.absolutePath)
      } catch (error: Throwable) {
        output.delete()
        promise.reject("E_VIDEO_PREVIEW_PREPARE", error.message ?: "The editing preview could not be prepared", error)
      }
    }
  }

  fun close() {
    handler.post {
      val task = active ?: return@post
      active = null
      task.transformer.cancel()
      task.output.delete()
      task.promise.reject("E_VIDEO_PREVIEW_CANCELLED", "Video preview preparation was cancelled", null)
    }
  }

  private fun claim(transformer: Transformer): ActivePreview? {
    val task = active ?: return null
    if (task.transformer !== transformer) return null
    active = null
    return task
  }

  private fun videoFormat(inputUri: String): MediaFormat {
    val extractor = MediaExtractor()
    return try {
      val uri = Uri.parse(inputUri)
      if (uri.scheme.isNullOrEmpty() || uri.scheme == "file") extractor.setDataSource(uri.path ?: inputUri)
      else extractor.setDataSource(context, uri, null)
      (0 until extractor.trackCount).map(extractor::getTrackFormat)
        .firstOrNull { it.getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true }
        ?: throw IllegalArgumentException("The selected file does not contain a video track")
    } finally {
      extractor.release()
    }
  }

  private fun outputFile(value: String): File {
    val uri = Uri.parse(value)
    require(uri.scheme.isNullOrEmpty() || uri.scheme == "file") { "The preview output must use app file storage" }
    return File(uri.path ?: value)
  }

  private data class ActivePreview(val transformer: Transformer, val output: File, val promise: Promise)
}
