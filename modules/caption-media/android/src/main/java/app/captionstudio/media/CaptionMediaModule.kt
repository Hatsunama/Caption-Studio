package app.captionstudio.media

import android.Manifest
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Typeface
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.net.Uri
import android.os.Build
import androidx.exifinterface.media.ExifInterface
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.interfaces.permissions.Permissions
import expo.modules.interfaces.permissions.PermissionsStatus
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max
import kotlin.math.roundToInt

class CaptionMediaModule : Module() {
  private val segmentationLock = Any()
  private var previewSegmenter: MediaPipePersonSegmenter? = null
  private var previewMatteProcessor: PersonMatteProcessor? = null
  private val timelineVideoExporter = lazy { TimelineVideoExporter(context) }
  private val audioExtractionEpoch = AtomicLong(0L)
  private var previewDestroyed = false
  private var previewEpoch = 0L
  private var previewInput: String? = null
  private var previewTimeMs = -1L

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("CaptionMedia")

    AsyncFunction("persistReadPermission") { inputUri: String ->
      persistReadPermission(inputUri)
    }

    AsyncFunction("releaseReadPermission") { inputUri: String ->
      releaseReadPermission(inputUri)
    }

    AsyncFunction("sha256") { inputUri: String ->
      sha256(inputUri)
    }

    AsyncFunction("getMediaInfo") { inputUri: String ->
      readMediaInfo(inputUri)
    }

    AsyncFunction("validateImageFile") { inputUri: String ->
      validateImageFile(inputUri)
    }

    AsyncFunction("validateFontFile") { inputUri: String ->
      validateFontFile(inputUri)
    }

    AsyncFunction("extractAudioToWav") { inputUri: String, outputUri: String ->
      val requestEpoch = audioExtractionEpoch.incrementAndGet()
      decodeAudioToWav(inputUri, outputUri, requestEpoch)
    }

    AsyncFunction("cancelAudioExtraction") {
      audioExtractionEpoch.incrementAndGet()
    }

    AsyncFunction("extractAudioTrack") { inputUri: String, outputUri: String ->
      extractAudioTrack(inputUri, outputUri)
    }

    AsyncFunction("generateVideoThumbnail") { inputUri: String, outputUri: String, timeMs: Long ->
      generateVideoThumbnail(inputUri, outputUri, timeMs)
    }

    AsyncFunction("renderPersonPreviewFrame") { inputUri: String, backgroundUri: String?, outputUri: String, options: Map<String, Any> ->
      renderPersonPreviewFrame(
        inputUri,
        backgroundUri,
        outputUri,
        (options["timeMs"] as? Number)?.toLong() ?: 0L,
        (options["backgroundTimeMs"] as? Number)?.toLong()
          ?: (options["timeMs"] as? Number)?.toLong()
          ?: 0L,
        (options["threshold"] as? Number)?.toFloat() ?: 0.46f,
        (options["softness"] as? Number)?.toFloat() ?: 0.14f,
        options["qualityPreset"] as? String ?: "stable",
        (options["temporalStability"] as? Number)?.toFloat() ?: 0.78f,
        (options["edgeFeather"] as? Number)?.toFloat() ?: 0.45f,
        (options["positionX"] as? Number)?.toFloat() ?: 0.5f,
        (options["positionY"] as? Number)?.toFloat() ?: 0.5f,
        (options["scale"] as? Number)?.toFloat() ?: 1f,
        (options["rotation"] as? Number)?.toFloat() ?: 0f,
        (options["outputWidth"] as? Number)?.toInt() ?: 720,
        (options["outputHeight"] as? Number)?.toInt() ?: 720,
        options["videoFit"] as? String ?: "fit",
        (options["videoPositionX"] as? Number)?.toFloat() ?: 0.5f,
        (options["videoPositionY"] as? Number)?.toFloat() ?: 0.5f,
        (options["videoScale"] as? Number)?.toFloat() ?: 1f,
        (options["videoRotation"] as? Number)?.toFloat() ?: 0f,
      )
    }

    AsyncFunction("resetPersonSegmentation") {
      synchronized(segmentationLock) {
        if (!previewDestroyed) {
          previewEpoch += 1L
          releasePreviewModelsLocked()
        }
      }
    }

    AsyncFunction("requestLegacyMediaWritePermission") { promise: Promise ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) promise.resolve(true)
      else {
        val permissions = appContext.permissions
        if (permissions == null) {
          promise.reject("E_NO_PERMISSIONS", "Android permission handling is unavailable", null)
        } else {
          permissions.askForPermissions(
            { result ->
              promise.resolve(result[Manifest.permission.WRITE_EXTERNAL_STORAGE]?.status == PermissionsStatus.GRANTED)
            },
            Manifest.permission.WRITE_EXTERNAL_STORAGE,
          )
        }
      }
    }

    AsyncFunction("exportTimelineVideo") { outputPath: String, renderPlan: Map<String, Any>, promise: Promise ->
      timelineVideoExporter.value.start(
        outputFile(outputPath).absolutePath,
        parseTimelineRenderPlan(renderPlan),
        promise,
      )
    }

    AsyncFunction("cancelTimelineVideoExport") {
      if (timelineVideoExporter.isInitialized()) timelineVideoExporter.value.cancel()
    }

    AsyncFunction("getTimelineVideoExportProgress") { promise: Promise ->
      if (!timelineVideoExporter.isInitialized()) {
        promise.resolve(mapOf<String, Any?>("stage" to "idle", "percent" to null))
      } else {
        timelineVideoExporter.value.getProgress { progress ->
          promise.resolve(mapOf<String, Any?>("stage" to progress.stage, "percent" to progress.percent))
        }
      }
    }

    OnDestroy {
      audioExtractionEpoch.incrementAndGet()
      synchronized(segmentationLock) {
        previewDestroyed = true
        previewEpoch += 1L
        releasePreviewModelsLocked()
      }
      if (timelineVideoExporter.isInitialized()) timelineVideoExporter.value.close()
    }
  }

  private fun renderPersonPreviewFrame(
    input: String,
    background: String?,
    output: String,
    timeMs: Long,
    backgroundTimeMs: Long,
    threshold: Float,
    softness: Float,
    qualityPreset: String,
    temporalStability: Float,
    edgeFeather: Float,
    positionX: Float,
    positionY: Float,
    scale: Float,
    rotation: Float,
    requestedOutputWidth: Int,
    requestedOutputHeight: Int,
    videoFit: String,
    videoPositionX: Float,
    videoPositionY: Float,
    videoScale: Float,
    videoRotation: Float,
  ): Map<String, Any> {
    val retriever = MediaMetadataRetriever()
    var foreground: Bitmap? = null
    var backgroundBitmap: Bitmap? = null
    var rendered: Bitmap? = null
    var isolated: Bitmap? = null
    var targetFile: File? = null
    var completed = false
    return try {
      val requestEpoch = beginPreview()
      setRetrieverDataSource(retriever, input)
      val sourceWidth = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      val sourceHeight = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
      val sourceRotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      val previewSize = previewFrameSize(sourceWidth, sourceHeight)
      val decoded = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1 && previewSize.first > 0) {
        retriever.getScaledFrameAtTime(
          max(0L, timeMs) * 1_000L,
          MediaMetadataRetriever.OPTION_CLOSEST,
          previewSize.first,
          previewSize.second,
        )
      } else {
        retriever.getFrameAtTime(max(0L, timeMs) * 1_000L, MediaMetadataRetriever.OPTION_CLOSEST)
      } ?: throw IllegalArgumentException("The requested video frame could not be decoded")
      foreground = orientBitmapAndRecycle(decoded, sourceRotation)
      val source = requireNotNull(foreground)
      val matte = synchronized(segmentationLock) {
        ensurePreviewActiveLocked(requestEpoch)
        if (previewInput != input || timeMs < previewTimeMs || timeMs - previewTimeMs > PREVIEW_RESET_GAP_MS) {
          resetPreviewMatteLocked()
        }
        previewInput = input
        previewTimeMs = timeMs
        val segmenter = previewSegmenter ?: MediaPipePersonSegmenter(context).also { previewSegmenter = it }
        val matteProcessor = previewMatteProcessor ?: PersonMatteProcessor().also { previewMatteProcessor = it }
        val result = segmenter.segment(source)
        PreviewMatte(
          result.width,
          result.height,
          matteProcessor.process(
            result.confidence,
            result.width,
            result.height,
            source,
            PersonMatteSettings(qualityPreset, threshold, softness, temporalStability, edgeFeather),
          ),
        )
      }
      isolated = applyAlphaMask(source, matte.alpha, matte.width, matte.height)
      val outputWidth = requestedOutputWidth.coerceIn(2, MAX_PERSON_PREVIEW_DIMENSION)
      val outputHeight = requestedOutputHeight.coerceIn(2, MAX_PERSON_PREVIEW_DIMENSION)
      val composed = Bitmap.createBitmap(outputWidth, outputHeight, Bitmap.Config.ARGB_8888)
      rendered = composed
      val canvas = Canvas(composed)
      if (background != null) {
        backgroundBitmap = readBackground(background, backgroundTimeMs, outputWidth, outputHeight)
        drawBitmapFill(canvas, requireNotNull(backgroundBitmap), outputWidth, outputHeight)
      } else {
        canvas.drawColor(Color.TRANSPARENT)
      }
      val personMatrix = personContentMatrix(
        source.width,
        source.height,
        outputWidth,
        outputHeight,
        if (videoFit == "fill") "fill" else "fit",
        videoPositionX.coerceIn(-1f, 2f),
        videoPositionY.coerceIn(-1f, 2f),
        videoScale.coerceIn(0.05f, 12f),
        videoRotation,
        positionX.coerceIn(-1f, 2f),
        positionY.coerceIn(-1f, 2f),
        scale.coerceIn(0.05f, 8f),
        rotation,
      )
      canvas.drawBitmap(requireNotNull(isolated), personMatrix, null)
      ensurePreviewActive(requestEpoch)
      val target = outputFile(output)
      targetFile = target
      target.parentFile?.mkdirs()
      FileOutputStream(target).use { stream ->
        check(composed.compress(Bitmap.CompressFormat.PNG, 100, stream)) { "The segmented preview could not be saved" }
      }
      completed = true
      mapOf("outputUri" to Uri.fromFile(target).toString(), "width" to outputWidth, "height" to outputHeight, "timeMs" to max(0L, timeMs))
    } finally {
      retriever.release()
      foreground?.recycle()
      backgroundBitmap?.recycle()
      rendered?.recycle()
      isolated?.recycle()
      if (!completed) targetFile?.delete()
    }
  }

  private fun readBackground(input: String, timeMs: Long, targetWidth: Int, targetHeight: Int): Bitmap {
    return readBackgroundVideoFrame(input, timeMs, targetWidth, targetHeight)
      ?: readBitmap(input, targetWidth, targetHeight)
  }

  private fun readBackgroundVideoFrame(input: String, timeMs: Long, targetWidth: Int, targetHeight: Int): Bitmap? {
    val retriever = MediaMetadataRetriever()
    var decoded: Bitmap? = null
    return try {
      setRetrieverDataSource(retriever, input)
      val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
      val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      val loopedTimeMs = if (durationMs > 0) max(0L, timeMs) % durationMs else max(0L, timeMs)
      val decodeWidth = if (rotationSwapsDimensions(rotation)) targetHeight else targetWidth
      val decodeHeight = if (rotationSwapsDimensions(rotation)) targetWidth else targetHeight
      decoded = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
        retriever.getScaledFrameAtTime(
          loopedTimeMs * 1_000L,
          MediaMetadataRetriever.OPTION_CLOSEST,
          max(1, decodeWidth),
          max(1, decodeHeight),
        )
      } else {
        retriever.getFrameAtTime(loopedTimeMs * 1_000L, MediaMetadataRetriever.OPTION_CLOSEST)
      }
      val frame = decoded ?: return null
      decoded = null
      orientBitmapAndRecycle(frame, rotation)
    } catch (error: Throwable) {
      if (error is CancellationException || error is Error) throw error
      null
    } finally {
      decoded?.recycle()
      retriever.release()
    }
  }

  private fun previewFrameSize(width: Int, height: Int): Pair<Int, Int> {
    if (width <= 0 || height <= 0) return 0 to 0
    val scale = minOf(1.0, PERSON_PREVIEW_LONG_EDGE / max(width, height).toDouble())
    return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
  }

  private fun drawBitmapFill(canvas: Canvas, bitmap: Bitmap, targetWidth: Int, targetHeight: Int) {
    val fillScale = max(targetWidth / bitmap.width.toFloat(), targetHeight / bitmap.height.toFloat())
    val matrix = Matrix().apply {
      postTranslate(-bitmap.width / 2f, -bitmap.height / 2f)
      postScale(fillScale, fillScale)
      postTranslate(targetWidth / 2f, targetHeight / 2f)
    }
    canvas.drawBitmap(bitmap, matrix, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
  }

  private fun readBitmap(input: String, targetWidth: Int, targetHeight: Int): Bitmap {
    val orientation = try {
      openInputStream(input, "The selected background could not be opened").use { stream ->
        BitmapOrientation.fromExif(ExifInterface(stream))
      }
    } catch (error: Throwable) {
      if (error is CancellationException || error is Error) throw error
      BitmapOrientation.NORMAL
    }
    val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
    openInputStream(input, "The selected background could not be opened").use { stream ->
      android.graphics.BitmapFactory.decodeStream(stream, null, bounds)
    }
    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "The selected background is not a supported image" }
    val options = android.graphics.BitmapFactory.Options().apply {
      inSampleSize = bitmapSampleSize(bounds.outWidth, bounds.outHeight, targetWidth, targetHeight)
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    val decoded = openInputStream(input, "The selected background could not be opened").use { stream ->
      android.graphics.BitmapFactory.decodeStream(stream, null, options)
    } ?: throw IllegalArgumentException("The selected background is not a supported image")
    return orientBitmapAndRecycle(decoded, orientation)
  }

  private fun bitmapSampleSize(sourceWidth: Int, sourceHeight: Int, targetWidth: Int, targetHeight: Int): Int {
    var sample = 1
    while (sourceWidth / (sample * 2) >= targetWidth && sourceHeight / (sample * 2) >= targetHeight) {
      sample *= 2
    }
    return sample
  }

  private fun openInputStream(input: String, errorMessage: String): InputStream {
    val uri = Uri.parse(input)
    return if (uri.scheme.isNullOrEmpty() || uri.scheme == "file") {
      File(uri.path ?: input).inputStream()
    } else {
      context.contentResolver.openInputStream(uri) ?: throw IllegalArgumentException(errorMessage)
    }
  }

  private fun persistReadPermission(input: String): Boolean {
    val uri = Uri.parse(input)
    if (uri.scheme != "content") return true
    context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
    return true
  }

  private fun releaseReadPermission(input: String): Boolean {
    val uri = Uri.parse(input)
    if (uri.scheme != "content") return true
    val resolver = context.contentResolver
    val persisted = resolver.persistedUriPermissions.any { permission ->
      permission.uri == uri && permission.isReadPermission
    }
    if (!persisted) return false
    return try {
      resolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      true
    } catch (_: SecurityException) {
      false
    }
  }

  private fun beginPreview(): Long {
    if (Thread.currentThread().isInterrupted) throw CancellationException("The person preview was cancelled")
    return synchronized(segmentationLock) {
      check(!previewDestroyed) { "The person preview compositor has been released" }
      previewEpoch
    }
  }

  private fun ensurePreviewActive(requestEpoch: Long) {
    if (Thread.currentThread().isInterrupted) throw CancellationException("The person preview was cancelled")
    synchronized(segmentationLock) { ensurePreviewActiveLocked(requestEpoch) }
  }

  private fun ensurePreviewActiveLocked(requestEpoch: Long) {
    check(!previewDestroyed) { "The person preview compositor has been released" }
    if (requestEpoch != previewEpoch) throw CancellationException("The person preview was cancelled")
    if (Thread.currentThread().isInterrupted) throw CancellationException("The person preview was cancelled")
  }

  private fun resetPreviewMatteLocked() {
    previewInput = null
    previewTimeMs = -1L
    previewMatteProcessor?.reset()
  }

  private fun releasePreviewModelsLocked() {
    resetPreviewMatteLocked()
    previewSegmenter?.close()
    previewSegmenter = null
    previewMatteProcessor?.close()
    previewMatteProcessor = null
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
        if (Thread.currentThread().isInterrupted) throw CancellationException("File hashing was cancelled")
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
    var completed = false
    return try {
      setRetrieverDataSource(retriever, input)
      val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
      val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      val target = thumbnailSize(width, height)
      val decoded = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1 && target.first > 0 && target.second > 0) {
        retriever.getScaledFrameAtTime(
          max(0L, timeMs) * 1_000L,
          MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
          target.first,
          target.second,
        )
      } else {
        retriever.getFrameAtTime(max(0L, timeMs) * 1_000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
      }
      val recovered = decoded ?: retriever.frameAtTime
      if (recovered != null) {
        frame = orientBitmapAndRecycle(recovered, rotation)
      }

      val renderedFrame = frame ?: throw IllegalArgumentException("The first video frame could not be decoded")
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
      var hasVideoTrack = false
      var videoMimeType = ""
      var trackWidth = 0
      var trackHeight = 0
      var trackRotation: Int? = null
      var trackFrameRate = 0.0
      var fallbackDurationUs = 0L
      for (index in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(index)
        val mime = format.getString(MediaFormat.KEY_MIME).orEmpty()
        if (mime.startsWith("audio/")) hasAudio = true
        if (!hasVideoTrack && mime.startsWith("video/")) {
          hasVideoTrack = true
          videoMimeType = mime
          trackWidth = mediaFormatInt(format, MediaFormat.KEY_WIDTH)
          trackHeight = mediaFormatInt(format, MediaFormat.KEY_HEIGHT)
          trackRotation = mediaFormatInt(format, MediaFormat.KEY_ROTATION).takeIf { it != 0 }
          trackFrameRate = mediaFormatFrameRate(format)
        }
        if (format.containsKey(MediaFormat.KEY_DURATION)) {
          fallbackDurationUs = max(fallbackDurationUs, format.getLong(MediaFormat.KEY_DURATION))
        }
      }
      val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
        ?.toLongOrNull()
        ?.takeIf { it > 0L }
        ?: fallbackDurationUs / 1_000L
      val retrieverWidth = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      val retrieverHeight = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
      val width = trackWidth.takeIf { it > 0 } ?: retrieverWidth
      val height = trackHeight.takeIf { it > 0 } ?: retrieverHeight
      val rawRotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull()
        ?: trackRotation
        ?: 0
      val rotation = normalizedVideoRotation(rawRotation)
      val frameRate = detectedVideoFrameRate(retriever, durationMs, trackFrameRate)
      val dimensionsValid = validVideoDimensions(width, height)
      val frameDecodable = hasVideoTrack
        && durationMs > 0L
        && dimensionsValid
        && rotation != null
        && probeVideoFrame(retriever, durationMs, width, height)
      mapOf(
        "durationMs" to max(0L, durationMs),
        "width" to width,
        "height" to height,
        "rotation" to (rotation ?: rawRotation),
        "frameRate" to frameRate,
        "hasAudio" to hasAudio,
        "hasVideoTrack" to hasVideoTrack,
        "hasVideo" to frameDecodable,
        "videoMimeType" to videoMimeType,
      )
    } finally {
      retriever.release()
      extractor.release()
    }
  }

  private fun probeVideoFrame(
    retriever: MediaMetadataRetriever,
    durationMs: Long,
    width: Int,
    height: Int,
  ): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1 && width.toLong() * height > MAX_LEGACY_VIDEO_PROBE_PIXELS) {
      return false
    }
    var frame: Bitmap? = null
    return try {
      val probeTimeUs = minOf(1_000L, max(0L, durationMs / 2L)) * 1_000L
      frame = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
        retriever.getScaledFrameAtTime(
          probeTimeUs,
          MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
          VIDEO_PROBE_EDGE,
          VIDEO_PROBE_EDGE,
        )
      } else {
        retriever.getFrameAtTime(probeTimeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
      }
      if (frame == null) frame = retriever.frameAtTime
      val decoded = frame
      decoded != null && decoded.width > 0 && decoded.height > 0
    } catch (_: RuntimeException) {
      false
    } finally {
      frame?.recycle()
    }
  }

  private fun validateImageFile(input: String): Map<String, Any> {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    openInputStream(input, "The selected image could not be opened").use { stream ->
      BitmapFactory.decodeStream(stream, null, bounds)
    }
    val width = bounds.outWidth
    val height = bounds.outHeight
    val mimeType = bounds.outMimeType.orEmpty().lowercase()
    require(width > 0 && height > 0 && mimeType in SUPPORTED_IMAGE_MIME_TYPES) {
      "The selected file is not a supported image"
    }
    require(width <= MAX_IMPORTED_IMAGE_DIMENSION && height <= MAX_IMPORTED_IMAGE_DIMENSION) {
      "The selected image is wider or taller than the ${MAX_IMPORTED_IMAGE_DIMENSION}px safety limit"
    }
    require(width.toLong() * height.toLong() <= MAX_IMPORTED_IMAGE_PIXELS) {
      "The selected image exceeds the ${MAX_IMPORTED_IMAGE_PIXELS / 1_000_000L}-megapixel safety limit"
    }
    val options = BitmapFactory.Options().apply {
      inSampleSize = imageValidationSampleSize(width, height)
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    val decoded = openInputStream(input, "The selected image could not be opened").use { stream ->
      BitmapFactory.decodeStream(stream, null, options)
    } ?: throw IllegalArgumentException("The selected image data could not be decoded")
    try {
      require(decoded.width > 0 && decoded.height > 0) { "The selected image data is incomplete" }
    } finally {
      decoded.recycle()
    }
    return mapOf("width" to width, "height" to height, "mimeType" to mimeType)
  }

  private fun validateFontFile(input: String): Map<String, Any> {
    val bytes = openInputStream(input, "The selected font could not be opened").use { stream ->
      val output = ByteArrayOutputStream()
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = stream.read(buffer)
        if (count < 0) break
        if (count > 0) {
          require(output.size().toLong() + count <= MAX_IMPORTED_FONT_BYTES) {
            "The selected font exceeds the ${MAX_IMPORTED_FONT_BYTES / (1024L * 1024L)} MB safety limit"
          }
          output.write(buffer, 0, count)
        }
      }
      output.toByteArray()
    }
    require(bytes.size >= MIN_IMPORTED_FONT_BYTES) { "The selected font file is incomplete" }
    val fontInfo = SfntFontValidator.validate(bytes)
    val localFile = outputFile(input)
    try {
      Typeface.createFromFile(localFile)
    } catch (error: RuntimeException) {
      throw IllegalArgumentException("Android could not load the selected font", error)
    }
    return mapOf("flavor" to fontInfo.flavor, "tableCount" to fontInfo.tableCount)
  }

  private fun imageValidationSampleSize(width: Int, height: Int): Int {
    var sampleSize = 1
    while (max(width, height) / sampleSize > IMAGE_VALIDATION_EDGE) sampleSize *= 2
    return sampleSize
  }

  private fun mediaFormatInt(format: MediaFormat, key: String): Int {
    return if (format.containsKey(key)) format.getInteger(key) else 0
  }

  private fun mediaFormatFrameRate(format: MediaFormat): Double {
    if (!format.containsKey(MediaFormat.KEY_FRAME_RATE)) return 0.0
    return runCatching { format.getInteger(MediaFormat.KEY_FRAME_RATE).toDouble() }
      .recoverCatching { format.getFloat(MediaFormat.KEY_FRAME_RATE).toDouble() }
      .getOrDefault(0.0)
  }

  private fun detectedVideoFrameRate(
    retriever: MediaMetadataRetriever,
    durationMs: Long,
    trackFrameRate: Double,
  ): Double {
    val frameCountRate = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && durationMs > 0L) {
      val frameCount = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)
        ?.toLongOrNull()
        ?: 0L
      if (frameCount > 0L) frameCount * 1_000.0 / durationMs else 0.0
    } else {
      0.0
    }
    val captureFrameRate = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)
      ?.toDoubleOrNull()
      ?: 0.0
    val detected = sequenceOf(frameCountRate, trackFrameRate, captureFrameRate)
      .firstOrNull { it.isFinite() && it > 0.0 }
      ?: DEFAULT_VIDEO_FRAME_RATE
    return detected.coerceIn(MIN_VIDEO_FRAME_RATE, MAX_VIDEO_FRAME_RATE)
  }

  private fun normalizedVideoRotation(rotation: Int): Int? {
    val normalized = ((rotation % 360) + 360) % 360
    return normalized.takeIf { it == 0 || it == 90 || it == 180 || it == 270 }
  }

  private fun validVideoDimensions(width: Int, height: Int): Boolean {
    return width in 1..MAX_VIDEO_DIMENSION
      && height in 1..MAX_VIDEO_DIMENSION
      && width.toLong() * height.toLong() <= MAX_VIDEO_PIXELS
  }

  private fun decodeAudioToWav(input: String, output: String, requestEpoch: Long): Map<String, Any> {
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
      val declaredDurationUs = if (inputFormat.containsKey(MediaFormat.KEY_DURATION)) {
        inputFormat.getLong(MediaFormat.KEY_DURATION).coerceAtLeast(0L)
      } else {
        0L
      }
      val maximumOutputSamples = if (declaredDurationUs > 0L) {
        ((declaredDurationUs / 1_000L + AUDIO_DURATION_TOLERANCE_MS) * TARGET_SAMPLE_RATE / 1_000L)
          .coerceAtMost(MAX_AUDIO_OUTPUT_SAMPLES)
      } else {
        MAX_AUDIO_OUTPUT_SAMPLES
      }
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
        if (Thread.currentThread().isInterrupted || audioExtractionEpoch.get() != requestEpoch) {
          throw CancellationException("Audio extraction was cancelled")
        }
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
              require(targetStart <= maximumOutputSamples && targetEnd <= maximumOutputSamples) {
                "The decoded audio timestamps exceed the supported duration"
              }
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
      try {
        decoder?.release()
      } catch (_: Throwable) {
      }
      try {
        extractor.release()
      } catch (_: Throwable) {
      }
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
        if (Thread.currentThread().isInterrupted) throw CancellationException("Audio import was cancelled")
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
      if (error is CancellationException || error is Error) throw error
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
    val target = File(uri.path ?: output).canonicalFile
    val allowedRoots = listOf(context.filesDir, context.cacheDir, context.noBackupFilesDir).map(File::getCanonicalFile)
    require(allowedRoots.any { root -> target == root || target.path.startsWith(root.path + File.separator) }) {
      "Output must stay inside Caption Studio storage"
    }
    return target
  }

  companion object {
    private const val TARGET_SAMPLE_RATE = 16_000
    private const val AUDIO_DURATION_TOLERANCE_MS = 5_000L
    private const val MAX_AUDIO_OUTPUT_SAMPLES = 691_200_000L
    private const val TIMEOUT_US = 10_000L
    private const val PREVIEW_RESET_GAP_MS = 1_500L
    private const val PERSON_PREVIEW_LONG_EDGE = 720.0
    private const val MAX_PERSON_PREVIEW_DIMENSION = 1_080
    private const val VIDEO_PROBE_EDGE = 96
    private const val DEFAULT_VIDEO_FRAME_RATE = 30.0
    private const val MIN_VIDEO_FRAME_RATE = 1.0
    private const val MAX_VIDEO_FRAME_RATE = 240.0
    private const val MAX_VIDEO_DIMENSION = 16_384
    private const val MAX_VIDEO_PIXELS = 134_217_728L
    private const val MAX_LEGACY_VIDEO_PROBE_PIXELS = 16_777_216L
    private const val IMAGE_VALIDATION_EDGE = 2_048
    private const val MAX_IMPORTED_IMAGE_DIMENSION = 16_384
    private const val MAX_IMPORTED_IMAGE_PIXELS = 80_000_000L
    private const val MIN_IMPORTED_FONT_BYTES = 1_024
    private const val MAX_IMPORTED_FONT_BYTES = 25L * 1024L * 1024L
    private val SUPPORTED_IMAGE_MIME_TYPES = setOf(
      "image/avif",
      "image/bmp",
      "image/gif",
      "image/heic",
      "image/heif",
      "image/jpeg",
      "image/png",
      "image/webp",
    )
  }
}

private data class PreviewMatte(val width: Int, val height: Int, val alpha: ByteArray)

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
    try {
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
    } finally {
      stream.close()
    }
  }
}

private fun RandomAccessFile.writeLittleEndianInt(value: Int) {
  writeInt(Integer.reverseBytes(value))
}

private fun RandomAccessFile.writeLittleEndianShort(value: Int) {
  writeShort(java.lang.Short.reverseBytes(value.toShort()).toInt())
}
