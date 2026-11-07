package app.captionstudio.media

import android.graphics.BitmapFactory
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
    assertEquals(Size(plan.width, plan.height), (item.effects.videoEffects.single() as Presentation).configure(360, 640))
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
        assertEquals(Color.parseColor(plan.backgroundColor), bitmap.getPixel(plan.width / 2, plan.height / 2))
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
    burnCaptions = false, videoTransform = clips.first().transform, clips = clips,
    captions = emptyList(), layers = emptyList(), audioClips = emptyList(),
  )
}
