package app.captionstudio.media

import android.graphics.BitmapFactory
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.Size
import androidx.media3.effect.Presentation
import androidx.media3.transformer.EditedMediaItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TimelineNativeVideoGapTest {
  @Test
  fun genuineHalfSecondGapUsesCanvasWithoutChangingEitherSourceBoundary() {
    val plan = plan(8_500, listOf(clip(0, 6_385, 0, 6_385), clip(6_885, 8_500, 6_385, 8_000)))
    withCanvas(plan) { exporter, canvas ->
      val footage = exporter.buildNativeVideoSequence(plan, canvas)
      val items = footage.editedMediaItems
      assertEquals(3, items.size)
      assertClip(items[0], plan.clips[0], plan)
      assertCanvasGap(items[1], canvas, 500, plan)
      assertClip(items[2], plan.clips[1], plan)
      assertEquals(8_500_000L, items.sumOf { durationUs(it) })
      assertEquals(setOf(C.TRACK_TYPE_VIDEO), footage.trackTypes)

      val base = EditedMediaItem.Builder(canvas).setFrameRate(plan.frameRate).setRemoveAudio(true).build()
      val connected = clockedVideoSequences(base, footage)
      assertEquals(3, connected.size)
      assertSame(footage, connected[1])
      assertSame(base, connected[0].editedMediaItems.single())
      assertSame(base, connected[2].editedMediaItems.single())
      val compositor = TimelineVideoCompositorSettings(plan)
      listOf(6_333_333L, 6_375_000L).forEach { timeUs ->
        assertEquals(1f, compositor.getOverlaySettings(1, timeUs).alphaScale, 0f)
      }
      assertEquals(0f, compositor.getOverlaySettings(1, 6_385_000).alphaScale, 0f)
      assertEquals(0f, compositor.getOverlaySettings(1, 6_884_999).alphaScale, 0f)
      assertEquals(1f, compositor.getOverlaySettings(1, 6_885_000).alphaScale, 0f)
      assertEquals(1f, compositor.getOverlaySettings(2, 6_500_000).alphaScale, 0f)
    }
  }

  @Test
  fun leadingInteriorAndTrailingGapsKeepTheirOwnDurationsAndCanvasFormat() {
    val plan = plan(4_000, listOf(clip(125, 1_125, 100, 2_100, 2f), clip(1_625, 3_625, 50, 1_050, 0.5f)))
    withCanvas(plan) { exporter, canvas ->
      val sequence = exporter.buildNativeVideoSequence(plan, canvas)
      val items = sequence.editedMediaItems
      assertEquals(5, items.size)
      listOf(0 to 125L, 2 to 500L, 4 to 375L).forEach { (index, durationMs) ->
        assertCanvasGap(items[index], canvas, durationMs, plan)
      }
      assertClip(items[1], plan.clips[0], plan)
      assertClip(items[3], plan.clips[1], plan)
      assertEquals(4_000_000L, items.sumOf { durationUs(it) })
      assertEquals(4_000L, canvas.localConfiguration!!.imageDurationMs)
    }
  }

  @Test
  fun contiguousClipsHaveNoSyntheticItemsIncludingAtTimelineEdges() {
    val plan = plan(8_000, listOf(clip(0, 6_385, 0, 6_385), clip(6_385, 8_000, 6_385, 8_000)))
    withCanvas(plan) { exporter, canvas ->
      val items = exporter.buildNativeVideoSequence(plan, canvas).editedMediaItems
      assertEquals(2, items.size)
      items.zip(plan.clips).forEach { (item, clip) -> assertClip(item, clip, plan) }
      assertEquals(8_000_000L, items.sumOf { durationUs(it) })
    }
  }

  @Test
  fun outputPtsAloneOwnGapVisibilityIncludingThePreviouslyBlack6375Frame() {
    val plan = plan(8_500, listOf(clip(0, 6_385, 0, 6_385), clip(6_885, 8_500, 6_385, 8_000)))
      .copy(width = 32, height = 32)
    withOverlay(plan) { overlay ->
      listOf(6_333_333L, 6_375_000L, 6_384_999L, 6_885_000L).forEach {
        assertEquals("Output PTS $it must leave native footage visible", Color.TRANSPARENT, overlay.getBitmap(it).getPixel(0, 0))
      }
      listOf(6_385_000L, 6_416_667L, 6_500_000L, 6_884_999L).forEach {
        assertEquals(Color.parseColor(plan.backgroundColor), overlay.getBitmap(it).getPixel(0, 0))
      }
      // Reusing the bitmap must clear the opaque cover on returning to footage.
      assertEquals(Color.TRANSPARENT, overlay.getBitmap(6_885_000).getPixel(0, 0))
    }
  }

  @Test
  fun leadingTrailingAndEmptyPlansRenderTheirBackgroundAtOutputPts() {
    val plan = plan(4_000, listOf(clip(125, 3_625, 0, 3_500))).copy(width = 32, height = 32)
    withOverlay(plan) { overlay ->
      listOf(0L, 124_999L, 3_625_000L, 3_999_999L).forEach {
        assertEquals(Color.parseColor(plan.backgroundColor), overlay.getBitmap(it).getPixel(0, 0))
      }
      listOf(125_000L, 3_624_999L).forEach {
        assertEquals(Color.TRANSPARENT, overlay.getBitmap(it).getPixel(0, 0))
      }
    }
    val empty = plan.copy(clips = emptyList())
    withOverlay(empty) { overlay ->
      assertEquals(Color.parseColor(empty.backgroundColor), overlay.getBitmap(0).getPixel(0, 0))
      assertEquals(Color.parseColor(empty.backgroundColor), overlay.getBitmap(3_999_999).getPixel(0, 0))
    }
    withCanvas(empty) { _, canvas ->
      val base = EditedMediaItem.Builder(canvas).setFrameRate(empty.frameRate).setRemoveAudio(true).build()
      // Empty plans never register an all-dropped secondary source: Media3's
      // compositor requires at least one texture from every registered source.
      assertEquals(1, clockedVideoSequences(base, null).size)
    }
  }

  @Test
  fun alphaBackgroundCoverIsOpaqueAndMatchesPinnedBasePngSamplingAndBlending() {
    val plan = plan(1_000, listOf(clip(0, 500, 0, 500))).copy(width = 32, height = 32)
    // Expected default SDR MP4 RGB: uploaded premultiplied PNG RGB, then
    // SRC_ALPHA blending in DefaultCompositorGlProgram (not a single flatten).
    listOf("#CC8844" to "#CC8844", "#FFCC8844" to "#CC8844", "#80CC8844" to "#332211",
      "#00CC8844" to "#000000", "transparent" to "#000000").forEach { (input, expected) ->
      val colored = plan.copy(backgroundColor = input)
      withOverlay(colored) { overlay ->
        assertEquals(Color.TRANSPARENT, overlay.getBitmap(499_999).getPixel(0, 0))
        assertEquals("Background $input", Color.parseColor(expected), overlay.getBitmap(500_000).getPixel(0, 0))
      }
      withCanvas(colored) { _, canvasItem ->
        val decoded = requireNotNull(BitmapFactory.decodeFile(canvasItem.localConfiguration!!.uri.path))
        try {
          // Compare against the actual export-owned PNG through the public
          // color API. Raw Bitmap storage is RGBA or BGRA by native platform;
          // its byte offsets do not define the GL upload's color channels.
          val sampled = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
          try {
            sampled.eraseColor(Color.BLACK)
            android.graphics.Canvas(sampled).drawBitmap(decoded, 0f, 0f, null)
            val pixel = sampled.getPixel(0, 0)
            val alpha = Color.alpha(decoded.getPixel(0, 0))
            val rgb = listOf(Color.red(pixel), Color.green(pixel), Color.blue(pixel))
              .map { kotlin.math.round(it * alpha / 255.0).toInt() }
            assertEquals(Color.parseColor(expected), Color.rgb(rgb[0], rgb[1], rgb[2]))
          } finally { sampled.recycle() }
        } finally { decoded.recycle() }
      }
    }
    withOverlay(plan.copy(clips = emptyList(), backgroundColor = "#80CC8844")) {
      // No compositor in the existing single-canvas path: no second multiply.
      assertEquals(Color.parseColor("#664422"), it.getBitmap(0).getPixel(0, 0))
    }
  }

  @Test
  fun gapCoverStaysBelowExistingImageLayersAndClearsOnNextFootageFrame() {
    val context = RuntimeEnvironment.getApplication()
    val image = File.createTempFile("gap-layer", ".png", context.cacheDir)
    val pixel = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
    try {
      pixel.eraseColor(Color.RED)
      image.outputStream().use { pixel.compress(Bitmap.CompressFormat.PNG, 100, it) }
      val plan = plan(1_000, listOf(clip(0, 500, 0, 500))).copy(width = 32, height = 32,
        layers = listOf(ImageRenderLayer("image", true, Uri.fromFile(image).toString(), 500, 900,
          0.5f, 0.5f, 0.5f, 0.5f, 0f, 1f)))
      withOverlay(plan) { overlay ->
        val bitmap = overlay.getBitmap(600_000)
        assertEquals(Color.RED, bitmap.getPixel(16, 16))
        assertEquals(Color.parseColor(plan.backgroundColor), bitmap.getPixel(0, 0))
        assertEquals(Color.TRANSPARENT, overlay.getBitmap(499_999).getPixel(16, 16))
      }
    } finally {
      pixel.recycle()
      image.delete()
    }
  }

  private fun withOverlay(plan: TimelineRenderPlan, block: (TimelineBitmapOverlay) -> Unit) {
    val overlay = TimelineBitmapOverlay(RuntimeEnvironment.getApplication(), plan,
      TimelineTransitionTimeline.create(plan.clips, emptyMap()))
    try { block(overlay) } finally { overlay.release() }
  }

  private fun assertCanvasGap(item: EditedMediaItem, canvas: MediaItem, durationMs: Long, plan: TimelineRenderPlan) {
    val local = item.mediaItem.localConfiguration!!
    assertEquals(canvas.localConfiguration!!.uri, local.uri)
    assertEquals(MimeTypes.IMAGE_PNG, local.mimeType)
    assertEquals(durationMs, local.imageDurationMs)
    assertEquals(durationMs * 1_000, item.durationUs)
    assertEquals(plan.frameRate, item.frameRate)
    assertTrue(item.removeAudio)
    assertFalse(item.removeVideo)
    assertTrue(item.effects.audioProcessors.isEmpty())
    assertTrue(item.effects.videoEffects.single() is TimelineVideoGapEffect)
  }

  private fun assertClip(item: EditedMediaItem, clip: RenderVideoClip, plan: TimelineRenderPlan) {
    assertEquals(Uri.parse(clip.uri), item.mediaItem.localConfiguration!!.uri)
    assertEquals(clip.sourceStartMs, item.mediaItem.clippingConfiguration.startPositionMs)
    assertEquals(clip.sourceEndMs, item.mediaItem.clippingConfiguration.endPositionMs)
    assertEquals(clip.playbackRate, item.speedProvider.getSpeed(0), 0f)
    assertTrue(item.removeAudio)
    assertEquals(Size(plan.width, plan.height), (item.effects.videoEffects.single() as Presentation).configure(360, 640))
  }

  private fun durationUs(item: EditedMediaItem): Long {
    if (item.mediaItem.localConfiguration!!.mimeType == MimeTypes.IMAGE_PNG) return item.durationUs
    val clipping = item.mediaItem.clippingConfiguration
    return ((clipping.endPositionMs - clipping.startPositionMs) * 1_000 / item.speedProvider.getSpeed(0)).toLong()
  }

  private fun withCanvas(plan: TimelineRenderPlan, block: (TimelineVideoExporter, MediaItem) -> Unit) {
    val context = RuntimeEnvironment.getApplication()
    val exporter = TimelineVideoExporter(context)
    val file = File.createTempFile("native-gap-canvas", ".png", context.cacheDir)
    try {
      // Use the exporter's actual canvas writer: gaps must retain its dimensions and user background.
      exporter.createBaseFrame(file, plan)
      val bitmap = requireNotNull(BitmapFactory.decodeFile(file.absolutePath))
      try {
        assertEquals(plan.width, bitmap.width)
        assertEquals(plan.height, bitmap.height)
        // Low-alpha PNGs may round RGB when converted back to straight color.
        assertEquals(Color.alpha(Color.parseColor(plan.backgroundColor)), Color.alpha(bitmap.getPixel(0, 0)))
        if (Color.alpha(Color.parseColor(plan.backgroundColor)) == 255) {
          assertEquals(Color.parseColor(plan.backgroundColor), bitmap.getPixel(plan.width / 2, plan.height / 2))
        }
      } finally {
        bitmap.recycle()
      }
      val canvas = MediaItem.Builder().setUri(Uri.fromFile(file)).setMimeType(MimeTypes.IMAGE_PNG)
        .setImageDurationMs(plan.durationMs).build()
      block(exporter, canvas)
      assertTrue("Sequence construction must not delete the export-owned canvas", file.exists())
    } finally {
      exporter.close()
      file.delete()
    }
  }

  private fun clip(start: Long, end: Long, sourceStart: Long, sourceEnd: Long, rate: Float = 1f) = RenderVideoClip(
    id = "clip-$start", uri = "content://footage/clip-$start", timelineStartMs = start, timelineEndMs = end,
    availableSourceStartMs = sourceStart, availableSourceEndMs = sourceEnd,
    sourceStartMs = sourceStart, sourceEndMs = sourceEnd, playbackRate = rate, volume = 1f, muted = false,
    fadeInMs = 0, fadeOutMs = 0, transitionType = "none", transitionDurationMs = 0,
    transform = VideoTransform("fit", 0.5f, 0.5f, 1f, 1f, 1f, 0f),
  )

  private fun plan(duration: Long, clips: List<RenderVideoClip>) = TimelineRenderPlan(
    durationMs = duration, width = 1080, height = 1920, frameRate = 24, backgroundColor = "#315A7F",
    burnCaptions = false, videoTransform = clips.firstOrNull()?.transform ?: VideoTransform("fit", 0.5f, 0.5f, 1f, 1f, 1f, 0f), clips = clips,
    captions = emptyList(), layers = emptyList(), audioClips = emptyList(),
  )
}
