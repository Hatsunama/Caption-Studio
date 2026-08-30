package app.captionstudio.media

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.RectF
import android.media.MediaExtractor
import android.media.MediaMetadataRetriever
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.exifinterface.media.ExifInterface
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.OverlaySettings
import androidx.media3.common.VideoCompositorSettings
import androidx.media3.common.audio.GainProcessor
import androidx.media3.common.audio.SpeedProvider
import androidx.media3.common.util.Size
import androidx.media3.effect.BitmapOverlay
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.StaticOverlaySettings
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import expo.modules.kotlin.Promise
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.LinkedHashMap
import java.util.concurrent.CancellationException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

internal class TimelineVideoExporter(private val context: Context) {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val stateLock = Any()
  private val publishingExecutor = Executors.newSingleThreadExecutor()
  private var activeExport: ActiveExport? = null

  fun start(outputPath: String, plan: TimelineRenderPlan, promise: Promise) {
    val output = File(outputPath)
    val task = try {
      synchronized(stateLock) {
        check(activeExport == null) { "An export is already running" }
        output.parentFile?.mkdirs()
        if (output.exists()) check(output.delete()) { "The previous export could not be replaced" }
        val baseFrame = File(output.parentFile, ".${output.nameWithoutExtension}-base.png")
        try {
          createBaseFrame(baseFrame, plan)
          val sourceInfoByUri = plan.clips.map(RenderVideoClip::uri).distinct().associateWith(::inspectMediaSource)
          val transitionTimeline = TimelineTransitionTimeline.create(
            plan.clips,
            sourceInfoByUri.mapValues { it.value.durationMs },
          )
          val overlay = TimelineBitmapOverlay(context, plan, transitionTimeline)
          ActiveExport(output, baseFrame, promise, overlay, transitionTimeline, sourceInfoByUri).also {
            activeExport = it
          }
        } catch (error: Throwable) {
          baseFrame.delete()
          throw error
        }
      }
    } catch (error: Throwable) {
      promise.reject("E_VIDEO_EXPORT", error.message ?: "Video export could not be prepared", error)
      return
    }

    try {
      val composition = buildComposition(plan, task)

      mainHandler.post {
        if (!isActive(task)) return@post
        try {
          val transformer = Transformer.Builder(context)
            .setVideoMimeType(MimeTypes.VIDEO_H264)
            .setAudioMimeType(MimeTypes.AUDIO_AAC)
            .addListener(object : Transformer.Listener {
              override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                if (!isActive(task)) return
                task.stage = ExportStage.PUBLISHING
                try {
                  releaseTaskResources(task)
                } catch (error: Throwable) {
                  fail(task, "E_VIDEO_EXPORT", "Video export resources could not be released", error)
                  return
                }
                publishingExecutor.execute {
                  try {
                    ensureActive(task)
                    val mediaUri = publishToMediaLibrary(task)
                    if (!claim(task)) {
                      deletePublishedOutput(task)
                      task.output.delete()
                      return@execute
                    }
                    task.output.delete()
                    promise.resolve(
                      mapOf(
                        "outputUri" to mediaUri.toString(),
                        "durationMs" to exportResult.approximateDurationMs,
                        "width" to exportResult.width,
                        "height" to exportResult.height,
                        "sizeBytes" to exportResult.fileSizeBytes,
                        "mediaUri" to mediaUri.toString(),
                      ),
                    )
                  } catch (_: CancellationException) {
                    deletePublishedOutput(task)
                    task.output.delete()
                  } catch (error: Throwable) {
                    deletePublishedOutput(task)
                    if (claim(task)) {
                      task.output.delete()
                      promise.reject("E_MEDIA_LIBRARY", error.message ?: "The export could not be saved", error)
                    }
                  }
                }
              }

              override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                fail(task, "E_VIDEO_EXPORT", exportException.message ?: "Video export failed", exportException)
              }
            })
            .build()
          task.transformer = transformer
          task.stage = ExportStage.RENDERING
          transformer.start(composition, task.output.absolutePath)
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

  fun getProgress(callback: (TimelineExportProgress) -> Unit) {
    mainHandler.post {
      val task = synchronized(stateLock) { activeExport }
      if (task == null) {
        callback(TimelineExportProgress("idle", null))
        return@post
      }
      if (task.stage == ExportStage.PUBLISHING) {
        callback(TimelineExportProgress("publishing", 99))
        return@post
      }
      val transformer = task.transformer
      if (transformer == null || task.stage == ExportStage.PREPARING) {
        callback(TimelineExportProgress("preparing", 0))
        return@post
      }
      val holder = ProgressHolder()
      val state = transformer.getProgress(holder)
      callback(
        when (state) {
          Transformer.PROGRESS_STATE_AVAILABLE -> TimelineExportProgress("rendering", holder.progress.coerceIn(0, 98))
          Transformer.PROGRESS_STATE_WAITING_FOR_AVAILABILITY -> TimelineExportProgress("preparing", null)
          Transformer.PROGRESS_STATE_UNAVAILABLE -> TimelineExportProgress("rendering", null)
          else -> TimelineExportProgress("preparing", null)
        },
      )
    }
  }

  fun close() {
    mainHandler.post {
      cancelActive()
      publishingExecutor.shutdownNow()
    }
  }

  private fun buildComposition(plan: TimelineRenderPlan, task: ActiveExport): Composition {
    val baseVideoItem = MediaItem.Builder()
      .setUri(Uri.fromFile(task.baseFrame))
      .setMimeType(MimeTypes.IMAGE_PNG)
      .setImageDurationMs(plan.durationMs)
      .build()
    val baseVideo = EditedMediaItem.Builder(baseVideoItem)
      .setFrameRate(plan.frameRate)
      .setRemoveAudio(true)
      .build()
    val sequences = mutableListOf<EditedMediaItemSequence>()
    sequences += EditedMediaItemSequence.withVideoFrom(listOf(baseVideo))
    sequences += buildNativeVideoSequence(plan)
    sequences += EditedMediaItemSequence.withVideoFrom(listOf(baseVideo))
    sequences += buildOriginalAudioSequences(plan, task)
    plan.audioClips.mapNotNull { buildInsertedAudioSequence(it, plan.durationMs) }.forEach(sequences::add)
    return Composition.Builder(sequences)
      .setVideoCompositorSettings(TimelineVideoCompositorSettings(plan))
      .setEffects(Effects(emptyList(), listOf(OverlayEffect(listOf(task.overlay)))))
      .build()
  }

  private fun buildNativeVideoSequence(plan: TimelineRenderPlan): EditedMediaItemSequence {
    val builder = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_VIDEO))
    var cursorMs = 0L
    plan.clips.forEach { clip ->
      if (clip.timelineStartMs > cursorMs) builder.addGap((clip.timelineStartMs - cursorMs) * 1_000L)
      val layout = if (clip.transform.fit == "fill") {
        Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP
      } else {
        Presentation.LAYOUT_SCALE_TO_FIT
      }
      builder.addItem(
        EditedMediaItem.Builder(clippedMediaItem(clip.uri, clip.sourceStartMs, clip.sourceEndMs))
          .setRemoveAudio(true)
          .setSpeed(ConstantSpeedProvider(clip.playbackRate))
          .setEffects(
            Effects(
              emptyList(),
              listOf(Presentation.createForWidthAndHeight(plan.width, plan.height, layout)),
            ),
          )
          .build(),
      )
      cursorMs = clip.timelineEndMs
    }
    if (cursorMs < plan.durationMs) builder.addGap((plan.durationMs - cursorMs) * 1_000L)
    return builder.build()
  }

  private fun buildOriginalAudioSequences(plan: TimelineRenderPlan, task: ActiveExport): List<EditedMediaItemSequence> =
    plan.clips.mapNotNull { clip ->
      if (clip.muted || clip.volume <= 0f || task.sourceInfoByUri[clip.uri]?.hasAudio != true) return@mapNotNull null
      val segments = task.transitionTimeline.audioSegments(clip)
      val builder = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_AUDIO))
      if (segments.first().timelineStartMs > 0) builder.addGap(segments.first().timelineStartMs * 1_000L)
      segments.forEach { segment ->
        val gain = GainProcessor(TimelineClipGainProvider(clip, segment))
        builder.addItem(
          EditedMediaItem.Builder(clippedMediaItem(clip.uri, segment.sourceStartMs, segment.sourceEndMs))
            .setRemoveVideo(true)
            .setSpeed(ConstantSpeedProvider(segment.playbackRate))
            .setEffects(Effects(listOf(gain), emptyList()))
            .build(),
        )
      }
      builder.build()
    }

  private fun buildInsertedAudioSequence(clip: RenderAudioClip, timelineDurationMs: Long): EditedMediaItemSequence? {
    val availableDurationMs = (timelineDurationMs - clip.startMs).coerceAtLeast(0)
    val sourceEndMs = min(clip.sourceEndMs, clip.sourceStartMs + availableDurationMs)
    if (clip.muted || clip.volume <= 0f || sourceEndMs <= clip.sourceStartMs || !hasAudioTrack(clip.uri)) return null
    val builder = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_AUDIO))
    if (clip.startMs > 0) builder.addGap(clip.startMs * 1_000L)
    val durationMs = sourceEndMs - clip.sourceStartMs
    val gain = GainProcessor(ClipGainProvider(clip.volume, durationMs, clip.fadeInMs, clip.fadeOutMs))
    builder.addItem(
      EditedMediaItem.Builder(clippedMediaItem(clip.uri, clip.sourceStartMs, sourceEndMs))
        .setRemoveVideo(true)
        .setEffects(Effects(listOf(gain), emptyList()))
        .build(),
    )
    return builder.build()
  }

  private fun clippedMediaItem(uri: String, startMs: Long, endMs: Long) = MediaItem.Builder()
    .setUri(Uri.parse(uri))
    .setClippingConfiguration(
      MediaItem.ClippingConfiguration.Builder()
        .setStartPositionMs(startMs)
        .setEndPositionMs(endMs)
        .build(),
    )
    .build()

  private fun hasAudioTrack(uri: String): Boolean {
    val extractor = MediaExtractor()
    return try {
      val parsed = Uri.parse(uri)
      if (parsed.scheme.isNullOrEmpty() || parsed.scheme == "file") extractor.setDataSource(parsed.path ?: uri)
      else extractor.setDataSource(context, parsed, null)
      (0 until extractor.trackCount).any { index ->
        extractor.getTrackFormat(index).getString(android.media.MediaFormat.KEY_MIME)?.startsWith("audio/") == true
      }
    } catch (error: Throwable) {
      throw IllegalArgumentException("An audio source could not be inspected", error)
    } finally {
      extractor.release()
    }
  }

  private fun inspectMediaSource(uri: String): MediaSourceInfo {
    val retriever = MediaMetadataRetriever()
    val durationMs = try {
      setRetrieverDataSource(retriever, uri)
      retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        ?.takeIf { it > 0 }
        ?: throw IllegalArgumentException("A video source has no readable duration")
    } catch (error: Throwable) {
      throw IllegalArgumentException("A video source could not be inspected", error)
    } finally {
      retriever.release()
    }
    return MediaSourceInfo(durationMs, hasAudioTrack(uri))
  }

  private fun setRetrieverDataSource(retriever: MediaMetadataRetriever, value: String) {
    val uri = Uri.parse(value)
    if (uri.scheme.isNullOrEmpty() || uri.scheme == "file") retriever.setDataSource(uri.path ?: value)
    else retriever.setDataSource(context, uri)
  }

  private fun createBaseFrame(file: File, plan: TimelineRenderPlan) {
    file.parentFile?.mkdirs()
    val bitmap = Bitmap.createBitmap(plan.width, plan.height, Bitmap.Config.ARGB_8888)
    try {
      bitmap.eraseColor(Color.parseColor(plan.backgroundColor))
      FileOutputStream(file).use { stream ->
        check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) { "The export canvas could not be created" }
      }
    } finally {
      bitmap.recycle()
    }
  }

  private fun publishToMediaLibrary(task: ActiveExport): Uri {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return publishScoped(task)
    check(
      ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED,
    ) { "Allow storage access so Caption Studio can save this export to your media library." }
    @Suppress("DEPRECATION")
    val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), "Caption Studio")
    check(directory.exists() || directory.mkdirs()) { "Android could not create the Caption Studio media folder" }
    val destination = uniqueDestination(directory, task.output.name)
    task.publishedFile = destination
    task.output.inputStream().use { source -> destination.outputStream().use { copyCancellable(source, it, task) } }
    ensureActive(task)
    val latch = CountDownLatch(1)
    var scanned: Uri? = null
    MediaScannerConnection.scanFile(context, arrayOf(destination.absolutePath), arrayOf(MimeTypes.VIDEO_MP4)) { _, uri ->
      scanned = uri
      latch.countDown()
    }
    val deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
    while (!latch.await(250, TimeUnit.MILLISECONDS)) {
      ensureActive(task)
      check(System.nanoTime() < deadlineNanos) { "Android did not finish adding the export to the media library" }
    }
    ensureActive(task)
    return scanned ?: Uri.fromFile(destination)
  }

  private fun publishScoped(task: ActiveExport): Uri {
    val resolver = context.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.Video.Media.DISPLAY_NAME, task.output.name)
      put(MediaStore.Video.Media.MIME_TYPE, MimeTypes.VIDEO_MP4)
      put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/Caption Studio")
      put(MediaStore.Video.Media.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
      ?: throw IllegalStateException("Android could not create the exported video in the media library")
    task.publishedUri = uri
    try {
      resolver.openOutputStream(uri, "w")?.use { destination ->
        task.output.inputStream().use { source -> copyCancellable(source, destination, task) }
      }
        ?: throw IllegalStateException("Android could not open the exported video in the media library")
      ensureActive(task)
      values.clear()
      values.put(MediaStore.Video.Media.IS_PENDING, 0)
      check(resolver.update(uri, values, null, null) == 1) {
        "Android could not finish publishing the exported video"
      }
      return uri
    } catch (error: Throwable) {
      resolver.delete(uri, null, null)
      throw error
    }
  }

  private fun uniqueDestination(directory: File, requestedName: String): File {
    var candidate = File(directory, requestedName)
    var suffix = 2
    while (candidate.exists()) {
      candidate = File(directory, "${requestedName.substringBeforeLast('.')} ($suffix).mp4")
      suffix += 1
    }
    return candidate
  }

  private fun cancelActive() {
    val task = synchronized(stateLock) { activeExport.also { activeExport = null } } ?: return
    task.cancelled.set(true)
    task.transformer?.cancel()
    val cleanupError = runCatching { releaseTaskResources(task) }.exceptionOrNull()
    deletePublishedOutput(task)
    task.output.delete()
    task.promise.reject("E_EXPORT_CANCELLED", "Video export was cancelled", cleanupError)
  }

  private fun releaseTaskResources(task: ActiveExport) {
    if (!task.resourcesReleased.compareAndSet(false, true)) return
    try {
      task.overlay.release()
    } finally {
      task.baseFrame.delete()
    }
  }

  private fun ensureActive(task: ActiveExport) {
    if (task.cancelled.get() || !isActive(task) || Thread.currentThread().isInterrupted) {
      throw CancellationException("Video export was cancelled")
    }
  }

  private fun copyCancellable(source: InputStream, destination: OutputStream, task: ActiveExport) {
    val buffer = ByteArray(256 * 1024)
    while (true) {
      ensureActive(task)
      val count = source.read(buffer)
      if (count < 0) break
      destination.write(buffer, 0, count)
    }
    destination.flush()
  }

  private fun deletePublishedOutput(task: ActiveExport) {
    task.publishedUri?.let { uri -> runCatching { context.contentResolver.delete(uri, null, null) } }
    task.publishedUri = null
    task.publishedFile?.delete()
    task.publishedFile = null
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
    runCatching { releaseTaskResources(task) }.exceptionOrNull()?.let(error::addSuppressed)
    task.output.delete()
    task.promise.reject(code, message, error)
  }

  private data class ActiveExport(
    val output: File,
    val baseFrame: File,
    val promise: Promise,
    val overlay: TimelineBitmapOverlay,
    val transitionTimeline: TimelineTransitionTimeline,
    val sourceInfoByUri: Map<String, MediaSourceInfo>,
    var transformer: Transformer? = null,
    val cancelled: AtomicBoolean = AtomicBoolean(false),
    val resourcesReleased: AtomicBoolean = AtomicBoolean(false),
    @Volatile var stage: ExportStage = ExportStage.PREPARING,
    @Volatile var publishedUri: Uri? = null,
    @Volatile var publishedFile: File? = null,
  )

  private enum class ExportStage { PREPARING, RENDERING, PUBLISHING }

  private data class MediaSourceInfo(val durationMs: Long, val hasAudio: Boolean)
}

internal data class TimelineExportProgress(val stage: String, val percent: Int?)

internal class TimelineVideoCompositorSettings(
  private val plan: TimelineRenderPlan,
) : VideoCompositorSettings {
  override fun getOutputSize(inputSizes: List<Size>) = Size(plan.width, plan.height)

  override fun getOverlaySettings(inputId: Int, presentationTimeUs: Long): OverlaySettings {
    if (inputId == CLOCK_SEQUENCE_INDEX) {
      return StaticOverlaySettings.Builder().setAlphaScale(0f).build()
    }
    if (inputId != VIDEO_SEQUENCE_INDEX) return StaticOverlaySettings.Builder().build()
    val timeMs = (presentationTimeUs / 1_000L).coerceIn(0L, plan.durationMs)
    val clip = plan.clips.firstOrNull { timeMs >= it.timelineStartMs && timeMs < it.timelineEndMs }
      ?: return StaticOverlaySettings.Builder().setAlphaScale(0f).build()
    val transform = clip.transform
    return StaticOverlaySettings.Builder()
      .setAlphaScale(1f)
      .setOverlayFrameAnchor(0f, 0f)
      .setBackgroundFrameAnchor(
        transform.positionX * 2f - 1f,
        1f - transform.positionY * 2f,
      )
      .setScale(transform.scale, transform.scale)
      .setRotationDegrees(-transform.rotation)
      .build()
  }

  private companion object {
    const val CLOCK_SEQUENCE_INDEX = 0
    const val VIDEO_SEQUENCE_INDEX = 1
  }
}

private class TimelineBitmapOverlay(
  private val context: Context,
  private val plan: TimelineRenderPlan,
  private val transitionTimeline: TimelineTransitionTimeline,
) : BitmapOverlay() {
  private val retrievers = ClosingRetrieverCache(MAX_OPEN_RETRIEVERS)
  private val imageCache = BitmapMemoryCache(MAX_CACHED_IMAGE_BYTES)
  private val outputBuffer = ReusableOverlayBitmap(plan.width, plan.height)
  private val textPainter = TimelineTextPainter(context).apply { prepare(plan.textStyles()) }
  private val segmenter = plan.backgroundReplacement?.let { MediaPipePersonSegmenter(context) }
  private val matteProcessor = plan.backgroundReplacement?.let { PersonMatteProcessor() }
  private val transitionMatteProcessor = plan.backgroundReplacement?.let { PersonMatteProcessor() }
  private val personMotion = plan.backgroundReplacement?.let { background ->
    PersonMotionPath(background.transform.transform, background.keyframes)
  }
  private var activeMatteClipId: String? = null
  private var lastTimeMs = -1L
  private var released = false

  override fun configure(videoSize: Size) {
    require(videoSize.width == plan.width && videoSize.height == plan.height) { "The encoder canvas does not match the render plan" }
  }

  @Synchronized
  override fun getBitmap(presentationTimeUs: Long): Bitmap {
    check(!released) { "The timeline compositor has been released" }
    val timeMs = (presentationTimeUs / 1_000L).coerceIn(0L, plan.durationMs)
    val rendersVideo = plan.backgroundReplacement != null
    return outputBuffer.render(if (rendersVideo) Color.parseColor(plan.backgroundColor) else Color.TRANSPARENT) { canvas ->
      val transition = transitionTimeline.activeAt(timeMs)
      if (transition != null && transition.outgoing.transitionType in TimelineTransitionSpec.compositeTypes) {
        drawCompositeTransition(canvas, transition, timeMs)
      } else {
        if (rendersVideo) {
          val clip = plan.clips.find { timeMs >= it.timelineStartMs && timeMs < it.timelineEndMs }
          if (clip != null) drawClip(canvas, clip, timeMs)
        }
        if (transition != null) drawCoverTransition(canvas, transition, timeMs)
      }
      plan.layers.asReversed().forEach { layer ->
        if (!layer.visible) return@forEach
        when (layer) {
          is CaptionRenderLayer -> if (plan.burnCaptions) {
            plan.captions
              .filter { timeMs >= it.startMs && timeMs < it.endMs }
              .forEach { textPainter.drawCaption(canvas, it, timeMs, plan.width, plan.height) }
          }
          is TextRenderLayer -> textPainter.drawTextLayer(canvas, layer, timeMs, plan.width, plan.height)
          is ImageRenderLayer -> drawImageLayer(canvas, layer, timeMs)
        }
      }
      lastTimeMs = timeMs
    }
  }

  private fun drawClip(canvas: Canvas, clip: RenderVideoClip, timeMs: Long) {
    val sourceTimeMs = clip.sourceStartMs + ((timeMs - clip.timelineStartMs) * clip.playbackRate).toLong()
    val frame = retriever(clip.uri).frame(sourceTimeMs, decodeWidth, decodeHeight)
      ?: throw IllegalArgumentException("Video clip ${clip.id} could not decode a frame at $sourceTimeMs ms")
    try {
      val background = plan.backgroundReplacement
      if (background == null) {
        drawVideoFrame(canvas, frame, clip.transform)
        return
      }
      drawReplacementBackground(canvas, background, timeMs)
      if (activeMatteClipId != clip.id || timeMs < lastTimeMs) {
        matteProcessor?.reset()
        activeMatteClipId = clip.id
      }
      val confidence = requireNotNull(segmenter).segment(frame)
      val alpha = requireNotNull(matteProcessor).process(
        confidence.confidence,
        confidence.width,
        confidence.height,
        frame,
        background.settings,
      )
      val isolated = applyAlphaMask(frame, alpha, confidence.width, confidence.height)
      try {
        val motion = requireNotNull(personMotion).resolve(timeMs)
        drawPersonFrame(canvas, isolated, clip.transform, motion)
      } finally {
        isolated.recycle()
      }
    } finally {
      frame.recycle()
    }
  }

  private fun drawReplacementBackground(canvas: Canvas, background: RenderBackgroundReplacement, timeMs: Long) {
    val bitmap = if (background.kind == "video") {
      val managed = retriever(background.uri)
      managed.frame(timeMs % max(1L, managed.durationMs), plan.width, plan.height)
    } else {
      imageCache.getOrLoad(background.uri) { decodeImage(background.uri) }
    } ?: throw IllegalArgumentException("The replacement background could not decode a frame at $timeMs ms")
    drawBitmapFill(canvas, bitmap, 1f)
    if (background.kind == "video") bitmap.recycle()
  }

  private fun drawVideoFrame(canvas: Canvas, bitmap: Bitmap, transform: VideoTransform) {
    val matrix = contentMatrix(
      bitmap.width,
      bitmap.height,
      plan.width,
      plan.height,
      transform.fit,
      transform.positionX,
      transform.positionY,
      transform.scale,
      transform.rotation,
    )
    canvas.drawBitmap(bitmap, matrix, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
  }

  private fun drawPersonFrame(canvas: Canvas, bitmap: Bitmap, video: VideoTransform, person: PersonTransform) {
    val matrix = personContentMatrix(
      bitmap.width,
      bitmap.height,
      plan.width,
      plan.height,
      video.fit,
      video.positionX,
      video.positionY,
      video.scale,
      video.rotation,
      person.positionX,
      person.positionY,
      person.scale,
      person.rotation,
    )
    canvas.drawBitmap(bitmap, matrix, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
  }

  private fun drawCoverTransition(canvas: Canvas, transition: TimelineTransitionWindow, timeMs: Long) {
    val phase = transition.phaseAt(timeMs)
    val peak = 1f - abs(phase * 2f - 1f)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    when (transition.outgoing.transitionType) {
      "dip-white", "flash" -> {
        paint.color = Color.WHITE
        paint.alpha = (255 * if (transition.outgoing.transitionType == "flash") peak * peak else peak).toInt()
        canvas.drawRect(0f, 0f, plan.width.toFloat(), plan.height.toFloat(), paint)
      }
      "dip-black" -> {
        paint.color = Color.BLACK
        paint.alpha = (255 * peak).toInt()
        canvas.drawRect(0f, 0f, plan.width.toFloat(), plan.height.toFloat(), paint)
      }
      "shutter" -> {
        paint.color = Color.BLACK
        val blade = plan.height * peak / 2f
        canvas.drawRect(0f, 0f, plan.width.toFloat(), blade, paint)
        canvas.drawRect(0f, plan.height - blade, plan.width.toFloat(), plan.height.toFloat(), paint)
      }
      "color-wash-cyan", "color-wash-magenta" -> {
        paint.color = if (transition.outgoing.transitionType == "color-wash-cyan") Color.rgb(0, 217, 255) else Color.rgb(255, 22, 143)
        paint.alpha = (peak * 212f).toInt()
        canvas.drawRect(0f, 0f, plan.width.toFloat(), plan.height.toFloat(), paint)
        paint.color = if (transition.outgoing.transitionType == "color-wash-cyan") Color.rgb(101, 31, 255) else Color.rgb(255, 234, 0)
        paint.alpha = (peak * 92f).toInt()
        val edge = if (phase < 0.5f) plan.width * phase * 2f else plan.width * (2f - phase * 2f)
        canvas.drawRect(0f, 0f, edge, plan.height.toFloat(), paint)
      }
      "ripple-rings" -> {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = max(4f, min(plan.width, plan.height) * 0.012f)
        val maximumRadius = hypot(plan.width / 2f, plan.height / 2f)
        repeat(4) { index ->
          val ringPhase = (phase + index * 0.19f) % 1f
          paint.color = if (index % 2 == 0) Color.rgb(0, 229, 255) else Color.rgb(255, 60, 172)
          paint.alpha = (peak * (1f - ringPhase) * 210f).toInt()
          canvas.drawCircle(plan.width / 2f, plan.height / 2f, maximumRadius * ringPhase, paint)
        }
      }
    }
  }

  private fun drawCompositeTransition(canvas: Canvas, transition: TimelineTransitionWindow, timeMs: Long) {
    val phase = transition.phaseAt(timeMs)
    val outgoingSourceTimeMs = transition.outgoingSourceTimeMs(timeMs)
    val incomingSourceTimeMs = transition.incomingSourceTimeMs(timeMs)
    plan.backgroundReplacement?.let { drawReplacementBackground(canvas, it, timeMs) }
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    val type = transition.outgoing.transitionType
    if (type.startsWith("push-")) {
      val outgoingX = when (type) {
        "push-left" -> -plan.width * phase
        "push-right" -> plan.width * phase
        else -> 0f
      }
      val outgoingY = when (type) {
        "push-up" -> -plan.height * phase
        "push-down" -> plan.height * phase
        else -> 0f
      }
      val incomingX = when (type) {
        "push-left" -> plan.width * (1f - phase)
        "push-right" -> -plan.width * (1f - phase)
        else -> 0f
      }
      val incomingY = when (type) {
        "push-up" -> plan.height * (1f - phase)
        "push-down" -> -plan.height * (1f - phase)
        else -> 0f
      }
      drawTransitionSnapshot(canvas, transition.outgoing, outgoingSourceTimeMs, timeMs, 1f, translateX = outgoingX, translateY = outgoingY)
      drawTransitionSnapshot(canvas, transition.incoming, incomingSourceTimeMs, timeMs, 1f, translateX = incomingX, translateY = incomingY)
      return
    }

    val outgoingAlpha = if (plan.backgroundReplacement == null) 1f else 1f - phase
    drawTransitionSnapshot(canvas, transition.outgoing, outgoingSourceTimeMs, timeMs, outgoingAlpha)
    when (type) {
      "crossfade" -> drawTransitionSnapshot(canvas, transition.incoming, incomingSourceTimeMs, timeMs, phase)
      "fade-dark" -> {
        drawTransitionSnapshot(canvas, transition.incoming, incomingSourceTimeMs, timeMs, phase)
        paint.color = Color.BLACK
        paint.alpha = ((1f - abs(phase * 2f - 1f)) * 140f).toInt()
        canvas.drawRect(0f, 0f, plan.width.toFloat(), plan.height.toFloat(), paint)
      }
      "wipe-left", "wipe-right", "wipe-up", "wipe-down" -> {
        val clipRect = when (transition.outgoing.transitionType) {
          "wipe-left" -> RectF(plan.width * (1f - phase), 0f, plan.width.toFloat(), plan.height.toFloat())
          "wipe-right" -> RectF(0f, 0f, plan.width * phase, plan.height.toFloat())
          "wipe-up" -> RectF(0f, plan.height * (1f - phase), plan.width.toFloat(), plan.height.toFloat())
          else -> RectF(0f, 0f, plan.width.toFloat(), plan.height * phase)
        }
        drawTransitionSnapshot(canvas, transition.incoming, incomingSourceTimeMs, timeMs, 1f, clipRect = clipRect)
      }
      "slide-left" -> drawTransitionSnapshot(canvas, transition.incoming, incomingSourceTimeMs, timeMs, 1f, translateX = plan.width * (1f - phase))
      "slide-right" -> drawTransitionSnapshot(canvas, transition.incoming, incomingSourceTimeMs, timeMs, 1f, translateX = -plan.width * (1f - phase))
      "slide-up" -> drawTransitionSnapshot(canvas, transition.incoming, incomingSourceTimeMs, timeMs, 1f, translateY = plan.height * (1f - phase))
      "slide-down" -> drawTransitionSnapshot(canvas, transition.incoming, incomingSourceTimeMs, timeMs, 1f, translateY = -plan.height * (1f - phase))
      "zoom-in" -> drawTransitionSnapshot(canvas, transition.incoming, incomingSourceTimeMs, timeMs, phase, scaleX = 0.35f + phase * 0.65f, scaleY = 0.35f + phase * 0.65f)
      "zoom-out" -> drawTransitionSnapshot(canvas, transition.incoming, incomingSourceTimeMs, timeMs, phase, scaleX = 1.8f - phase * 0.8f, scaleY = 1.8f - phase * 0.8f)
      "spin" -> drawTransitionSnapshot(canvas, transition.incoming, incomingSourceTimeMs, timeMs, phase, scaleX = 0.4f + phase * 0.6f, scaleY = 0.4f + phase * 0.6f, rotation = (1f - phase) * 280f)
      "fold-horizontal" -> drawTransitionSnapshot(canvas, transition.incoming, incomingSourceTimeMs, timeMs, phase, scaleY = max(0.015f, phase))
      "fold-vertical" -> drawTransitionSnapshot(canvas, transition.incoming, incomingSourceTimeMs, timeMs, phase, scaleX = max(0.015f, phase))
      "wipe-diagonal-tl", "wipe-diagonal-tr", "wipe-diagonal-bl", "wipe-diagonal-br" -> {
        drawMaskedTransitionSnapshot(canvas, transition, incomingSourceTimeMs, timeMs, diagonalRevealPath(type, phase))
      }
      "iris-circle" -> {
        val radius = hypot(plan.width / 2f, plan.height / 2f) * phase
        val path = Path().apply { addCircle(plan.width / 2f, plan.height / 2f, radius, Path.Direction.CW) }
        drawMaskedTransitionSnapshot(canvas, transition, incomingSourceTimeMs, timeMs, path)
      }
      "iris-diamond" -> {
        val centerX = plan.width / 2f
        val centerY = plan.height / 2f
        val path = Path().apply {
          moveTo(centerX, centerY - plan.height * phase)
          lineTo(centerX + plan.width * phase, centerY)
          lineTo(centerX, centerY + plan.height * phase)
          lineTo(centerX - plan.width * phase, centerY)
          close()
        }
        drawMaskedTransitionSnapshot(canvas, transition, incomingSourceTimeMs, timeMs, path)
      }
      "split-horizontal" -> {
        val halfHeight = plan.height * phase / 2f
        val path = Path().apply { addRect(0f, plan.height / 2f - halfHeight, plan.width.toFloat(), plan.height / 2f + halfHeight, Path.Direction.CW) }
        drawMaskedTransitionSnapshot(canvas, transition, incomingSourceTimeMs, timeMs, path)
      }
      "split-vertical" -> {
        val halfWidth = plan.width * phase / 2f
        val path = Path().apply { addRect(plan.width / 2f - halfWidth, 0f, plan.width / 2f + halfWidth, plan.height.toFloat(), Path.Direction.CW) }
        drawMaskedTransitionSnapshot(canvas, transition, incomingSourceTimeMs, timeMs, path)
      }
      "blinds-horizontal" -> drawMaskedTransitionSnapshot(canvas, transition, incomingSourceTimeMs, timeMs, blindsPath(horizontal = true, phase))
      "blinds-vertical" -> drawMaskedTransitionSnapshot(canvas, transition, incomingSourceTimeMs, timeMs, blindsPath(horizontal = false, phase))
      "checkerboard" -> drawMaskedTransitionSnapshot(canvas, transition, incomingSourceTimeMs, timeMs, tiledRevealPath(8, 12, phase, randomOrder = false))
      "pixel-grid" -> drawMaskedTransitionSnapshot(canvas, transition, incomingSourceTimeMs, timeMs, tiledRevealPath(12, 18, phase, randomOrder = true))
      "radial-clock" -> drawMaskedTransitionSnapshot(canvas, transition, incomingSourceTimeMs, timeMs, radialRevealPath(phase))
      "stripes-diagonal" -> drawMaskedTransitionSnapshot(canvas, transition, incomingSourceTimeMs, timeMs, diagonalStripesPath(phase))
      "slice-shuffle" -> drawMaskedTransitionSnapshot(canvas, transition, incomingSourceTimeMs, timeMs, sliceShufflePath(phase))
      "glitch" -> {
        drawTransitionSnapshot(canvas, transition.incoming, incomingSourceTimeMs, timeMs, phase)
        val peak = 1f - abs(phase * 2f - 1f)
        repeat(9) { row ->
          paint.color = if (row % 2 == 0) Color.MAGENTA else Color.CYAN
          paint.alpha = (100 * peak).toInt()
          val top = row * plan.height / 9f
          canvas.drawRect(sin(row * 2f + phase * 20f) * 24f * peak, top, plan.width.toFloat(), top + plan.height / 18f, paint)
        }
      }
      else -> error("Video transition $type has no compositor")
    }
  }

  private fun drawMaskedTransitionSnapshot(
    canvas: Canvas,
    transition: TimelineTransitionWindow,
    incomingSourceTimeMs: Long,
    timelineTimeMs: Long,
    path: Path,
  ) {
    val checkpoint = canvas.save()
    try {
      canvas.clipPath(path)
      drawTransitionSnapshot(canvas, transition.incoming, incomingSourceTimeMs, timelineTimeMs, 1f)
    } finally {
      canvas.restoreToCount(checkpoint)
    }
  }

  private fun diagonalRevealPath(type: String, phase: Float): Path {
    val width = plan.width.toFloat()
    val height = plan.height.toFloat()
    val threshold = phase.coerceIn(0f, 1f) * 2f
    val path = Path()
    if (threshold <= 1f) {
      path.moveTo(0f, 0f)
      path.lineTo(width * threshold, 0f)
      path.lineTo(0f, height * threshold)
    } else {
      path.moveTo(0f, 0f)
      path.lineTo(width, 0f)
      path.lineTo(width, height * (threshold - 1f))
      path.lineTo(width * (threshold - 1f), height)
      path.lineTo(0f, height)
    }
    path.close()
    val mirror = Matrix().apply {
      setScale(
        if (type.endsWith("tr") || type.endsWith("br")) -1f else 1f,
        if (type.endsWith("bl") || type.endsWith("br")) -1f else 1f,
        width / 2f,
        height / 2f,
      )
    }
    path.transform(mirror)
    return path
  }

  private fun blindsPath(horizontal: Boolean, phase: Float): Path {
    val path = Path()
    val count = 10
    if (horizontal) {
      val cell = plan.height / count.toFloat()
      repeat(count) { index ->
        val top = index * cell
        path.addRect(0f, top, plan.width.toFloat(), top + cell * phase, Path.Direction.CW)
      }
    } else {
      val cell = plan.width / count.toFloat()
      repeat(count) { index ->
        val left = index * cell
        path.addRect(left, 0f, left + cell * phase, plan.height.toFloat(), Path.Direction.CW)
      }
    }
    return path
  }

  private fun tiledRevealPath(columns: Int, rows: Int, phase: Float, randomOrder: Boolean): Path {
    val path = Path()
    val cellWidth = plan.width / columns.toFloat()
    val cellHeight = plan.height / rows.toFloat()
    val count = columns * rows
    repeat(count) { index ->
      val row = index / columns
      val column = index % columns
      val threshold = if (randomOrder) ((index * 37) % count) / count.toFloat() * 0.68f else ((row + column) % 2) * 0.24f
      val local = ((phase - threshold) / (1f - threshold).coerceAtLeast(0.01f)).coerceIn(0f, 1f)
      if (local <= 0f) return@repeat
      val centerX = (column + 0.5f) * cellWidth
      val centerY = (row + 0.5f) * cellHeight
      val halfWidth = cellWidth * local / 2f + 0.5f
      val halfHeight = cellHeight * local / 2f + 0.5f
      path.addRect(centerX - halfWidth, centerY - halfHeight, centerX + halfWidth, centerY + halfHeight, Path.Direction.CW)
    }
    return path
  }

  private fun radialRevealPath(phase: Float): Path {
    val centerX = plan.width / 2f
    val centerY = plan.height / 2f
    val radius = hypot(centerX, centerY) + 2f
    return Path().apply {
      moveTo(centerX, centerY)
      lineTo(centerX, centerY - radius)
      arcTo(RectF(centerX - radius, centerY - radius, centerX + radius, centerY + radius), -90f, 360f * phase)
      close()
    }
  }

  private fun diagonalStripesPath(phase: Float): Path {
    val path = Path()
    val slant = plan.height * 0.3f
    val span = plan.width + slant * 2f
    val count = 14
    val bandWidth = span / count
    repeat(count) { index ->
      val threshold = index / count.toFloat() * 0.42f
      val local = ((phase - threshold) / 0.58f).coerceIn(0f, 1f)
      if (local <= 0f) return@repeat
      val left = -slant + index * bandWidth
      val right = left + bandWidth * local + 1f
      path.moveTo(left, 0f)
      path.lineTo(right, 0f)
      path.lineTo(right + slant, plan.height.toFloat())
      path.lineTo(left + slant, plan.height.toFloat())
      path.close()
    }
    return path
  }

  private fun sliceShufflePath(phase: Float): Path {
    val path = Path()
    val rows = 12
    val sliceHeight = plan.height / rows.toFloat()
    repeat(rows) { row ->
      val threshold = (row % 4) * 0.07f
      val local = ((phase - threshold) / (1f - threshold)).coerceIn(0f, 1f)
      val width = plan.width * local
      val top = row * sliceHeight
      val left = if (row % 2 == 0) 0f else plan.width - width
      path.addRect(left, top, left + width, top + sliceHeight + 0.5f, Path.Direction.CW)
    }
    return path
  }

  private fun drawTransitionSnapshot(
    canvas: Canvas,
    clip: RenderVideoClip,
    sourceTimeMs: Long,
    timelineTimeMs: Long,
    alpha: Float,
    clipRect: RectF? = null,
    translateX: Float = 0f,
    translateY: Float = 0f,
    scaleX: Float = 1f,
    scaleY: Float = 1f,
    rotation: Float = 0f,
  ) {
    val frame = retriever(clip.uri).frame(sourceTimeMs, decodeWidth, decodeHeight)
      ?: throw IllegalArgumentException("Transition clip ${clip.id} could not decode a frame at $sourceTimeMs ms")
    canvas.save()
    try {
      if (clipRect != null) canvas.clipRect(clipRect)
      canvas.translate(translateX, translateY)
      canvas.scale(scaleX, scaleY, plan.width / 2f, plan.height / 2f)
      canvas.rotate(rotation, plan.width / 2f, plan.height / 2f)
      val layer = canvas.saveLayerAlpha(null, (alpha.coerceIn(0f, 1f) * 255).toInt())
      val background = plan.backgroundReplacement
      if (background == null) {
        drawVideoFrame(canvas, frame, clip.transform)
      } else {
        val confidence = requireNotNull(segmenter).segment(frame)
        requireNotNull(transitionMatteProcessor).reset()
        val mask = transitionMatteProcessor.process(
          confidence.confidence,
          confidence.width,
          confidence.height,
          frame,
          background.settings,
        )
        val isolated = applyAlphaMask(frame, mask, confidence.width, confidence.height)
        try {
          drawPersonFrame(canvas, isolated, clip.transform, requireNotNull(personMotion).resolve(timelineTimeMs))
        } finally {
          isolated.recycle()
        }
      }
      canvas.restoreToCount(layer)
    } finally {
      canvas.restore()
      frame.recycle()
    }
  }

  private fun drawImageLayer(canvas: Canvas, layer: ImageRenderLayer, timeMs: Long) {
    if (timeMs !in layer.startMs until layer.endMs) return
    val bitmap = imageCache.getOrLoad(layer.uri) { decodeImage(layer.uri) }
    val width = layer.boxWidth * plan.width
    val height = layer.boxHeight * plan.height
    val containedScale = min(width / bitmap.width, height / bitmap.height)
    val matrix = Matrix().apply {
      postTranslate(-bitmap.width / 2f, -bitmap.height / 2f)
      postScale(containedScale, containedScale)
      postRotate(layer.rotation)
      postTranslate(layer.positionX * plan.width, layer.positionY * plan.height)
    }
    canvas.drawBitmap(bitmap, matrix, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply {
      alpha = (layer.opacity * 255).toInt()
    })
  }

  private fun drawBitmapFill(canvas: Canvas, bitmap: Bitmap, opacity: Float) {
    val scale = max(plan.width / bitmap.width.toFloat(), plan.height / bitmap.height.toFloat())
    val matrix = Matrix().apply {
      postTranslate(-bitmap.width / 2f, -bitmap.height / 2f)
      postScale(scale, scale)
      postTranslate(plan.width / 2f, plan.height / 2f)
    }
    canvas.drawBitmap(bitmap, matrix, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply { alpha = (opacity * 255).toInt() })
  }

  private fun retriever(uri: String) = retrievers.getOrLoad(uri) { ManagedRetriever(context, uri) }

  private fun decodeImage(uri: String): Bitmap {
    val orientation = runCatching {
      openImageStream(uri).use { BitmapOrientation.fromExif(ExifInterface(it)) }
    }.getOrDefault(BitmapOrientation.NORMAL)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    openImageStream(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "An overlay image could not be decoded" }
    val options = BitmapFactory.Options().apply {
      inSampleSize = imageSampleSize(bounds.outWidth, bounds.outHeight, plan.width, plan.height)
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    val decoded = openImageStream(uri).use { BitmapFactory.decodeStream(it, null, options) }
      ?: throw IllegalArgumentException("An overlay image could not be decoded")
    return orientBitmapAndRecycle(decoded, orientation)
  }

  private fun openImageStream(value: String): InputStream {
    val uri = Uri.parse(value)
    return if (uri.scheme.isNullOrEmpty() || uri.scheme == "file") {
      File(uri.path ?: value).inputStream()
    } else {
      context.contentResolver.openInputStream(uri)
        ?: throw IllegalArgumentException("An overlay image could not be opened")
    }
  }

  private fun imageSampleSize(sourceWidth: Int, sourceHeight: Int, targetWidth: Int, targetHeight: Int): Int {
    var sample = 1
    while (sourceWidth / (sample * 2) >= targetWidth && sourceHeight / (sample * 2) >= targetHeight) sample *= 2
    return sample
  }

  @Synchronized
  override fun release() {
    if (released) return
    released = true
    var failure: Exception? = null
    fun releaseResource(action: () -> Unit) {
      try {
        action()
      } catch (error: Exception) {
        if (failure == null) failure = error else requireNotNull(failure).addSuppressed(error)
      }
    }
    releaseResource { imageCache.close() }
    releaseResource { retrievers.close() }
    releaseResource { matteProcessor?.close() }
    releaseResource { transitionMatteProcessor?.close() }
    releaseResource { segmenter?.close() }
    releaseResource { textPainter.close() }
    releaseResource { super.release() }
    releaseResource { outputBuffer.close() }
    failure?.let { throw it }
  }

  private val decodeWidth: Int
    get() = decodeSize.first

  private val decodeHeight: Int
    get() = decodeSize.second

  private val decodeSize: Pair<Int, Int> by lazy {
    if (plan.backgroundReplacement == null || max(plan.width, plan.height) <= PERSON_MATTE_MAX_EDGE) {
      plan.width to plan.height
    } else {
      val ratio = PERSON_MATTE_MAX_EDGE.toFloat() / max(plan.width, plan.height)
      max(2, (plan.width * ratio).toInt()) to max(2, (plan.height * ratio).toInt())
    }
  }

  private companion object {
    const val PERSON_MATTE_MAX_EDGE = 1920
    const val MAX_OPEN_RETRIEVERS = 6
    const val MAX_CACHED_IMAGE_BYTES = 48 * 1024 * 1024
  }
}

private class ClosingRetrieverCache(private val maximumEntries: Int) : AutoCloseable {
  private val entries = LinkedHashMap<String, ManagedRetriever>(maximumEntries, 0.75f, true)

  fun getOrLoad(key: String, loader: () -> ManagedRetriever): ManagedRetriever {
    entries[key]?.let { return it }
    val loaded = loader()
    entries[key] = loaded
    while (entries.size > maximumEntries) {
      val eldest = entries.entries.iterator().next()
      entries.remove(eldest.key)
      eldest.value.close()
    }
    return loaded
  }

  override fun close() {
    entries.values.forEach(ManagedRetriever::close)
    entries.clear()
  }
}

private class BitmapMemoryCache(private val maximumBytes: Int) : AutoCloseable {
  private val entries = LinkedHashMap<String, Bitmap>(4, 0.75f, true)
  private var bytes = 0L

  fun getOrLoad(key: String, loader: () -> Bitmap): Bitmap {
    entries[key]?.let { return it }
    val loaded = loader()
    entries.put(key, loaded)?.let { replaced ->
      bytes -= replaced.allocationByteCount.toLong()
      replaced.recycle()
    }
    bytes += loaded.allocationByteCount.toLong()
    while (bytes > maximumBytes && entries.size > 1) {
      val eldest = entries.entries.iterator().next()
      entries.remove(eldest.key)
      bytes -= eldest.value.allocationByteCount.toLong()
      eldest.value.recycle()
    }
    return loaded
  }

  override fun close() {
    entries.values.forEach(Bitmap::recycle)
    entries.clear()
    bytes = 0
  }
}

private class ManagedRetriever(context: Context, uri: String) : AutoCloseable {
  private val retriever: MediaMetadataRetriever

  init {
    val created = MediaMetadataRetriever()
    try {
      val parsed = Uri.parse(uri)
      if (parsed.scheme.isNullOrEmpty() || parsed.scheme == "file") created.setDataSource(parsed.path ?: uri)
      else created.setDataSource(context, parsed)
      retriever = created
    } catch (failure: Throwable) {
      runCatching { created.release() }
      throw failure
    }
  }
  private val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
  private val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
  private val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
  private val displayWidth = if (rotationSwapsDimensions(rotation)) height else width
  private val displayHeight = if (rotationSwapsDimensions(rotation)) width else height
  val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 1L

  fun frame(timeMs: Long, targetWidth: Int, targetHeight: Int): Bitmap? {
    val timeUs = timeMs.coerceIn(0L, max(0L, durationMs - 1L)) * 1_000L
    return if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1 || displayWidth <= 0 || displayHeight <= 0) {
      retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST)
    } else {
      val scale = min(1.0, max(targetWidth, targetHeight).toDouble() / max(displayWidth, displayHeight).toDouble())
      retriever.getScaledFrameAtTime(
        timeUs,
        MediaMetadataRetriever.OPTION_CLOSEST,
        max(1, (displayWidth * scale).toInt()),
        max(1, (displayHeight * scale).toInt()),
      )
    }
  }

  override fun close() {
    retriever.release()
  }
}

private class ConstantSpeedProvider(private val speed: Float) : SpeedProvider {
  override fun getSpeed(timeUs: Long) = speed.coerceIn(0.1f, 8f)
  override fun getNextSpeedChangeTimeUs(timeUs: Long) = C.TIME_UNSET
}

private class TimelineClipGainProvider(
  private val clip: RenderVideoClip,
  private val segment: ClipAudioSegment,
) : GainProcessor.GainProvider {
  override fun getGainFactorAtSamplePosition(samplePosition: Long, sampleRate: Int): Float {
    val sourceElapsedMs = samplePosition * 1_000.0 / sampleRate
    val timelineTimeMs = segment.timelineStartMs + sourceElapsedMs / segment.playbackRate
    val visibleOffsetMs = timelineTimeMs - clip.timelineStartMs
    val userFadeIn = if (clip.fadeInMs > 0) {
      (visibleOffsetMs / clip.fadeInMs).coerceIn(0.0, 1.0)
    } else {
      1.0
    }
    val userFadeOut = if (clip.fadeOutMs > 0) {
      ((clip.timelineDurationMs - visibleOffsetMs) / clip.fadeOutMs).coerceIn(0.0, 1.0)
    } else {
      1.0
    }
    val transitionGain = transitionAudioGain(
      timelineTimeMs,
      segment.leftTransition,
      segment.rightTransition,
    )
    return (clip.volume * min(userFadeIn, userFadeOut) * transitionGain).toFloat().coerceIn(0f, 1f)
  }

  override fun isUnityUntil(samplePosition: Long, sampleRate: Int) = C.TIME_UNSET
}

private class ClipGainProvider(
  private val volume: Float,
  private val durationMs: Long,
  private val fadeInMs: Long,
  private val fadeOutMs: Long,
) : GainProcessor.GainProvider {
  override fun getGainFactorAtSamplePosition(samplePosition: Long, sampleRate: Int): Float {
    val timeMs = samplePosition * 1_000.0 / sampleRate
    val fadeIn = if (fadeInMs > 0) (timeMs / fadeInMs).coerceIn(0.0, 1.0) else 1.0
    val fadeOut = if (fadeOutMs > 0) ((durationMs - timeMs) / fadeOutMs).coerceIn(0.0, 1.0) else 1.0
    return (volume * min(fadeIn, fadeOut)).toFloat().coerceIn(0f, 1f)
  }

  override fun isUnityUntil(samplePosition: Long, sampleRate: Int) = C.TIME_UNSET
}

private fun TimelineRenderPlan.textStyles() = sequence {
  captions.forEach { caption ->
    yield(caption.style)
    caption.words.forEach { word -> yield(word.style) }
  }
  layers.forEach { layer -> if (layer is TextRenderLayer) yield(layer.style) }
}.asIterable()

internal class ReusableOverlayBitmap(private val width: Int, private val height: Int) : AutoCloseable {
  private var bitmap: Bitmap? = null
  private var canvas: Canvas? = null
  private var closed = false

  @Synchronized
  fun render(backgroundColor: Int, draw: (Canvas) -> Unit): Bitmap {
    check(!closed) { "The overlay frame buffer has been released" }
    val output = bitmap ?: Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { bitmap = it }
    val target = canvas ?: Canvas(output).also { canvas = it }
    target.drawColor(backgroundColor, PorterDuff.Mode.SRC)
    draw(target)
    return output
  }

  @Synchronized
  override fun close() {
    if (closed) return
    closed = true
    canvas = null
    bitmap?.recycle()
    bitmap = null
  }
}
