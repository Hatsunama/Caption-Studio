package app.captionstudio.media

import android.content.Context
import android.content.ContentValues
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Build
import android.provider.MediaStore
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.VideoFrameProcessingException
import androidx.media3.effect.BitmapOverlay
import androidx.media3.effect.OverlayEffect
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.Segmentation
import com.google.mlkit.vision.segmentation.selfie.SelfieSegmenterOptions
import expo.modules.kotlin.Promise
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.roundToInt

internal data class PersonExportOptions(
  val durationMs: Long,
  val sourceStartMs: Long,
  val backgroundKind: String,
  val threshold: Float,
  val softness: Float,
  val temporalStability: Float,
  val edgeFeather: Float,
  val positionX: Float,
  val positionY: Float,
  val scale: Float,
  val rotation: Float,
)

internal class PersonVideoExporter(private val context: Context) {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var activeTransformer: Transformer? = null
  private var activeOverlay: PersonForegroundOverlay? = null

  fun start(
    inputUri: String,
    backgroundUri: String,
    outputPath: String,
    options: PersonExportOptions,
    promise: Promise,
  ) {
    check(activeTransformer == null) { "An export is already running" }
    val output = File(outputPath)
    output.parentFile?.mkdirs()
    if (output.exists()) check(output.delete()) { "The previous export could not be replaced" }

    val overlay = PersonForegroundOverlay(context, inputUri, options)
    activeOverlay = overlay
    val overlayEffect = OverlayEffect(listOf(overlay))
    val backgroundItem = MediaItem.Builder()
      .setUri(Uri.parse(backgroundUri))
      .apply {
        if (options.backgroundKind == "image") {
          setImageDurationMs(options.durationMs)
          setMimeType(imageMimeType(backgroundUri))
        }
      }
      .build()
    val backgroundEdited = EditedMediaItem.Builder(backgroundItem)
      .setRemoveAudio(true)
      .setEffects(Effects(emptyList(), listOf(overlayEffect)))
      .build()
    val backgroundSequence = EditedMediaItemSequence.withVideoFrom(listOf(backgroundEdited)).buildUpon()
      .setIsLooping(options.backgroundKind == "video")
      .build()

    val audioItem = MediaItem.Builder()
      .setUri(Uri.parse(inputUri))
      .setClippingConfiguration(
        MediaItem.ClippingConfiguration.Builder()
          .setStartPositionMs(options.sourceStartMs)
          .setEndPositionMs(options.sourceStartMs + options.durationMs)
          .build(),
      )
      .build()
    val audioEdited = EditedMediaItem.Builder(audioItem)
      .setRemoveVideo(true)
      .build()
    val audioSequence = EditedMediaItemSequence.withAudioFrom(listOf(audioEdited))
    val composition = Composition.Builder(listOf(backgroundSequence, audioSequence)).build()

    mainHandler.post {
      val transformer = Transformer.Builder(context)
        .setVideoMimeType(MimeTypes.VIDEO_H264)
        .setAudioMimeType(MimeTypes.AUDIO_AAC)
        .addListener(object : Transformer.Listener {
          override fun onCompleted(composition: Composition, exportResult: ExportResult) {
            try {
              val mediaUri = publishToMediaLibrary(output)
              promise.resolve(
                mapOf(
                  "outputUri" to Uri.fromFile(output).toString(),
                  "durationMs" to exportResult.approximateDurationMs,
                  "width" to exportResult.width,
                  "height" to exportResult.height,
                  "sizeBytes" to exportResult.fileSizeBytes,
                  "mediaUri" to (mediaUri?.toString() ?: Uri.fromFile(output).toString()),
                ),
              )
            } catch (error: Throwable) {
              promise.reject("E_MEDIA_LIBRARY", error.message ?: "The export could not be saved", error)
            } finally {
              finish()
            }
          }

          override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
            finish()
            output.delete()
            promise.reject("E_VIDEO_EXPORT", exportException.message ?: "Video export failed", exportException)
          }
        })
        .build()
      activeTransformer = transformer
      transformer.start(composition, output.absolutePath)
    }
  }

  fun cancel() {
    mainHandler.post {
      activeTransformer?.cancel()
      finish()
    }
  }

  private fun finish() {
    activeTransformer = null
    activeOverlay?.release()
    activeOverlay = null
  }

  private fun imageMimeType(uri: String): String = when (uri.substringBefore('?').substringAfterLast('.').lowercase()) {
    "jpg", "jpeg" -> MimeTypes.IMAGE_JPEG
    "webp" -> MimeTypes.IMAGE_WEBP
    "bmp" -> MimeTypes.IMAGE_BMP
    else -> MimeTypes.IMAGE_PNG
  }

  private fun publishToMediaLibrary(output: File): Uri? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
    val resolver = context.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.Video.Media.DISPLAY_NAME, output.name)
      put(MediaStore.Video.Media.MIME_TYPE, MimeTypes.VIDEO_MP4)
      put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/Caption Studio")
      put(MediaStore.Video.Media.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
      ?: throw IllegalStateException("Android could not create the exported video in the media library")
    try {
      resolver.openOutputStream(uri, "w")?.use { destination -> output.inputStream().use { it.copyTo(destination) } }
        ?: throw IllegalStateException("Android could not open the exported video in the media library")
      values.clear()
      values.put(MediaStore.Video.Media.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
      return uri
    } catch (error: Throwable) {
      resolver.delete(uri, null, null)
      throw error
    }
  }
}

private class PersonForegroundOverlay(
  private val context: Context,
  private val inputUri: String,
  private val options: PersonExportOptions,
) : BitmapOverlay() {
  private val retriever = MediaMetadataRetriever().apply { setDataSource(context, Uri.parse(inputUri)) }
  private val segmenter = Segmentation.getClient(
    SelfieSegmenterOptions.Builder()
      .setDetectorMode(SelfieSegmenterOptions.STREAM_MODE)
      .enableRawSizeMask()
      .build(),
  )
  private var previousConfidence: FloatArray? = null
  private var lastBitmap: Bitmap? = null

  @Synchronized
  override fun getBitmap(presentationTimeUs: Long): Bitmap {
    try {
      val decoded = retriever.getFrameAtTime(max(0L, presentationTimeUs + options.sourceStartMs * 1_000L), MediaMetadataRetriever.OPTION_CLOSEST)
        ?: throw VideoFrameProcessingException(IllegalStateException("A source frame could not be decoded"))
      val source = orient(decoded)
      val result = Tasks.await(segmenter.process(InputImage.fromBitmap(source, 0)))
      val confidence = stabilizeAndFeather(result.buffer, result.width, result.height)
      val isolated = applyAlpha(source, confidence, result.width, result.height)
      val canvasBitmap = Bitmap.createBitmap(source.width, source.height, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(canvasBitmap)
      canvas.drawColor(Color.TRANSPARENT)
      val matrix = Matrix().apply {
        postTranslate(-source.width / 2f, -source.height / 2f)
        postScale(options.scale.coerceIn(0.05f, 8f), options.scale.coerceIn(0.05f, 8f))
        postRotate(options.rotation)
        postTranslate(options.positionX.coerceIn(-1f, 2f) * source.width, options.positionY.coerceIn(-1f, 2f) * source.height)
      }
      canvas.drawBitmap(isolated, matrix, null)
      isolated.recycle()
      if (source !== decoded) source.recycle()
      decoded.recycle()
      lastBitmap?.recycle()
      lastBitmap = canvasBitmap
      return canvasBitmap
    } catch (error: VideoFrameProcessingException) {
      throw error
    } catch (error: Throwable) {
      throw VideoFrameProcessingException(error)
    }
  }

  private fun orient(source: Bitmap): Bitmap {
    val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toFloatOrNull() ?: 0f
    return if (rotation % 360f == 0f) source else Bitmap.createBitmap(
      source, 0, 0, source.width, source.height, Matrix().apply { postRotate(rotation) }, true,
    )
  }

  private fun stabilizeAndFeather(buffer: ByteBuffer, width: Int, height: Int): FloatArray {
    buffer.rewind()
    val raw = FloatArray(width * height) { buffer.float.coerceIn(0f, 1f) }
    val prior = previousConfidence
    val stability = options.temporalStability.coerceIn(0f, 0.92f)
    val stable = if (prior != null && prior.size == raw.size) {
      FloatArray(raw.size) { index ->
        val weight = if (raw[index] >= prior[index]) stability * 0.55f else stability
        raw[index] * (1f - weight) + prior[index] * weight
      }
    } else raw
    previousConfidence = stable.copyOf()
    if (options.edgeFeather <= 0f || width < 3 || height < 3) return stable
    val feathered = stable.copyOf()
    val blend = options.edgeFeather.coerceIn(0f, 1f)
    for (y in 1 until height - 1) for (x in 1 until width - 1) {
      val index = y * width + x
      val value = stable[index]
      if (value in 0.04f..0.96f) {
        var sum = 0f
        for (dy in -1..1) for (dx in -1..1) sum += stable[(y + dy) * width + x + dx]
        feathered[index] = value * (1f - blend) + (sum / 9f) * blend
      }
    }
    return feathered
  }

  private fun applyAlpha(source: Bitmap, confidence: FloatArray, maskWidth: Int, maskHeight: Int): Bitmap {
    val alphaMask = Bitmap.createBitmap(maskWidth, maskHeight, Bitmap.Config.ALPHA_8)
    val edge = options.softness.coerceIn(0.001f, 1f)
    val low = options.threshold.coerceIn(0f, 1f) - edge / 2f
    val alpha = ByteArray(confidence.size) { index ->
      val linear = ((confidence[index] - low) / edge).coerceIn(0f, 1f)
      val smooth = linear * linear * (3f - 2f * linear)
      (smooth * 255f).roundToInt().toByte()
    }
    alphaMask.copyPixelsFromBuffer(ByteBuffer.wrap(alpha))
    val scaledMask = Bitmap.createScaledBitmap(alphaMask, source.width, source.height, true)
    val pixels = IntArray(source.width * source.height)
    val maskPixels = ByteArray(pixels.size)
    source.getPixels(pixels, 0, source.width, 0, 0, source.width, source.height)
    scaledMask.copyPixelsToBuffer(ByteBuffer.wrap(maskPixels))
    for (index in pixels.indices) pixels[index] = ((maskPixels[index].toInt() and 0xff) shl 24) or (pixels[index] and 0x00ffffff)
    val output = Bitmap.createBitmap(source.width, source.height, Bitmap.Config.ARGB_8888)
    output.setPixels(pixels, 0, source.width, 0, 0, source.width, source.height)
    scaledMask.recycle()
    alphaMask.recycle()
    return output
  }

  override fun release() {
    lastBitmap?.recycle()
    lastBitmap = null
    previousConfidence = null
    segmenter.close()
    retriever.release()
    super.release()
  }
}
