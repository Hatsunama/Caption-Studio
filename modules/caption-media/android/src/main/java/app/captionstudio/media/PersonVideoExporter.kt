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
import androidx.media3.common.util.Size
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
import java.util.concurrent.Executors
import kotlin.math.max

internal data class PersonExportOptions(
  val durationMs: Long,
  val sourceStartMs: Long,
  val backgroundKind: String,
  val qualityPreset: String,
  val threshold: Float,
  val softness: Float,
  val temporalStability: Float,
  val edgeFeather: Float,
  val positionX: Float,
  val positionY: Float,
  val scale: Float,
  val rotation: Float,
  val keyframes: List<PersonTransformFrame>,
)

internal class PersonVideoExporter(private val context: Context) {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val stateLock = Any()
  private val publishingExecutor = Executors.newSingleThreadExecutor()
  private var activeExport: ActiveExport? = null

  fun start(
    inputUri: String,
    backgroundUri: String,
    outputPath: String,
    options: PersonExportOptions,
    promise: Promise,
  ) {
    val output = File(outputPath)
    val task = try {
      synchronized(stateLock) {
        check(activeExport == null) { "An export is already running" }
        output.parentFile?.mkdirs()
        if (output.exists()) check(output.delete()) { "The previous export could not be replaced" }
        ActiveExport(
          output,
          promise,
          PersonForegroundOverlay(
            context,
            inputUri,
            options,
            outputRotationDegrees = mediaRotationDegrees(backgroundUri, options.backgroundKind),
          ),
        ).also { activeExport = it }
      }
    } catch (error: Throwable) {
      promise.reject("E_VIDEO_EXPORT", error.message ?: "Video export could not be prepared", error)
      return
    }
    try {
      val overlay = task.overlay
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
        .apply {
          if (options.backgroundKind == "image") setFrameRate(IMAGE_BACKGROUND_FRAME_RATE)
        }
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
        if (!isActive(task)) return@post
        try {
          val transformer = Transformer.Builder(context)
            .setVideoMimeType(MimeTypes.VIDEO_H264)
            .setAudioMimeType(MimeTypes.AUDIO_AAC)
            .addListener(object : Transformer.Listener {
              override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                if (!claim(task)) return
                task.overlay.release()
                publishingExecutor.execute {
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
                    output.delete()
                    promise.reject("E_MEDIA_LIBRARY", error.message ?: "The export could not be saved", error)
                  }
                }
              }

              override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                fail(task, "E_VIDEO_EXPORT", exportException.message ?: "Video export failed", exportException)
              }
            })
            .build()
          task.transformer = transformer
          transformer.start(composition, output.absolutePath)
        } catch (error: Throwable) {
          fail(task, "E_VIDEO_EXPORT", error.message ?: "Video export failed", error)
        }
      }
    } catch (error: Throwable) {
      fail(task, "E_VIDEO_EXPORT", error.message ?: "Video export could not be prepared", error)
    }
  }

  fun cancel() {
    mainHandler.post { cancelActive() }
  }

  fun close() {
    mainHandler.post {
      cancelActive()
      publishingExecutor.shutdown()
    }
  }

  private fun cancelActive() {
    val task = synchronized(stateLock) { activeExport.also { activeExport = null } } ?: return
    task.transformer?.cancel()
    task.overlay.release()
    task.output.delete()
    task.promise.reject("E_EXPORT_CANCELLED", "Video export was cancelled", null)
  }

  private fun isActive(task: ActiveExport) = synchronized(stateLock) { activeExport === task }

  private fun claim(task: ActiveExport) = synchronized(stateLock) {
    if (activeExport !== task) false else {
      activeExport = null
      true
    }
  }

  private fun fail(task: ActiveExport, code: String, message: String, error: Throwable) {
    if (!claim(task)) return
    task.overlay.release()
    task.output.delete()
    task.promise.reject(code, message, error)
  }

  private fun imageMimeType(uri: String): String = when (uri.substringBefore('?').substringAfterLast('.').lowercase()) {
    "jpg", "jpeg" -> MimeTypes.IMAGE_JPEG
    "webp" -> MimeTypes.IMAGE_WEBP
    "bmp" -> MimeTypes.IMAGE_BMP
    else -> MimeTypes.IMAGE_PNG
  }

  private fun mediaRotationDegrees(uri: String, kind: String): Int {
    if (kind != "video") return 0
    val retriever = MediaMetadataRetriever()
    return try {
      retriever.setDataSource(context, Uri.parse(uri))
      retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
        ?.toIntOrNull()
        ?.mod(360)
        ?: 0
    } finally {
      retriever.release()
    }
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

  private data class ActiveExport(
    val output: File,
    val promise: Promise,
    val overlay: PersonForegroundOverlay,
    var transformer: Transformer? = null,
  )

  private companion object {
    const val IMAGE_BACKGROUND_FRAME_RATE = 30
  }
}

private class PersonForegroundOverlay(
  private val context: Context,
  private val inputUri: String,
  private val options: PersonExportOptions,
  private val outputRotationDegrees: Int,
) : BitmapOverlay() {
  private val retriever = MediaMetadataRetriever().apply { setDataSource(context, Uri.parse(inputUri)) }
  private val segmenter = Segmentation.getClient(
    SelfieSegmenterOptions.Builder()
      .setDetectorMode(SelfieSegmenterOptions.STREAM_MODE)
      .enableRawSizeMask()
      .build(),
  )
  private val matteProcessor = PersonMatteProcessor()
  private val motionPath = PersonMotionPath(
    PersonTransform(options.positionX, options.positionY, options.scale, options.rotation),
    options.keyframes,
  )
  private val sourceWidth = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
  private val sourceHeight = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
  private var lastBitmap: Bitmap? = null
  private var outputSize: Size? = null
  private var released = false

  override fun configure(videoSize: Size) {
    outputSize = videoSize
  }

  @Synchronized
  override fun getBitmap(presentationTimeUs: Long): Bitmap {
    var decoded: Bitmap? = null
    var source: Bitmap? = null
    var isolated: Bitmap? = null
    var upright: Bitmap? = null
    var output: Bitmap? = null
    var completed = false
    try {
      val sourceTimeUs = max(0L, presentationTimeUs + options.sourceStartMs * 1_000L)
      decoded = decodeSourceFrame(sourceTimeUs)
        ?: throw VideoFrameProcessingException(IllegalStateException("A source frame could not be decoded"))
      source = decoded
      val frame = requireNotNull(source)
      val result = Tasks.await(segmenter.process(InputImage.fromBitmap(frame, 0)))
      val alpha = matteProcessor.process(
        result.buffer,
        result.width,
        result.height,
        frame,
        PersonMatteSettings(options.qualityPreset, options.threshold, options.softness, options.temporalStability, options.edgeFeather),
      )
      isolated = applyAlphaMask(frame, alpha, result.width, result.height)
      upright = Bitmap.createBitmap(frame.width, frame.height, Bitmap.Config.ARGB_8888).apply {
        setHasAlpha(true)
        eraseColor(Color.TRANSPARENT)
      }
      val canvas = Canvas(requireNotNull(upright))
      canvas.drawColor(Color.TRANSPARENT)
      val transform = motionPath.resolve(max(0L, presentationTimeUs / 1_000L))
      val matrix = Matrix().apply {
        postTranslate(-frame.width / 2f, -frame.height / 2f)
        postScale(transform.scale, transform.scale)
        postRotate(transform.rotation)
        postTranslate(transform.positionX * frame.width, transform.positionY * frame.height)
      }
      canvas.drawBitmap(requireNotNull(isolated), matrix, null)
      output = matchVideoFrame(requireNotNull(upright))
      if (output !== upright) {
        upright.recycle()
        upright = null
      }
      lastBitmap?.recycle()
      lastBitmap = output
      completed = true
      return requireNotNull(output)
    } catch (error: VideoFrameProcessingException) {
      throw error
    } catch (error: Throwable) {
      throw VideoFrameProcessingException(error)
    } finally {
      isolated?.recycle()
      if (source !== decoded) source?.recycle()
      decoded?.recycle()
      if (!completed) {
        if (output !== upright) output?.recycle()
        upright?.recycle()
      }
    }
  }

  private fun matchVideoFrame(upright: Bitmap): Bitmap {
    val target = outputSize ?: return upright
    if (upright.width == target.width && upright.height == target.height) return upright

    val oriented = if (upright.width == target.height && upright.height == target.width) {
      val inverseDisplayRotation = when (outputRotationDegrees) {
        90 -> -90f
        270 -> 90f
        else -> -90f
      }
      Bitmap.createBitmap(
        upright,
        0,
        0,
        upright.width,
        upright.height,
        Matrix().apply { postRotate(inverseDisplayRotation) },
        true,
      )
    } else {
      upright
    }
    if (oriented.width == target.width && oriented.height == target.height) return oriented

    val scaled = Bitmap.createScaledBitmap(oriented, target.width, target.height, true)
    if (oriented !== upright) oriented.recycle()
    return scaled
  }

  private fun decodeSourceFrame(timeUs: Long): Bitmap? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1 || sourceWidth <= 0 || sourceHeight <= 0) {
      return retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST)
    }
    val scale = minOf(1.0, EXPORT_LONG_EDGE / max(sourceWidth, sourceHeight).toDouble())
    return retriever.getScaledFrameAtTime(
      timeUs,
      MediaMetadataRetriever.OPTION_CLOSEST,
      max(1, (sourceWidth * scale).toInt()),
      max(1, (sourceHeight * scale).toInt()),
    )
  }

  override fun release() {
    if (released) return
    released = true
    lastBitmap?.recycle()
    lastBitmap = null
    matteProcessor.close()
    segmenter.close()
    retriever.release()
    super.release()
  }
}

private const val EXPORT_LONG_EDGE = 1920
