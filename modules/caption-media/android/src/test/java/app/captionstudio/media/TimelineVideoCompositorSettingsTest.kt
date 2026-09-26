package app.captionstudio.media

import androidx.media3.common.MediaItem
import androidx.media3.common.util.Size
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class TimelineVideoCompositorSettingsTest {
  @Test
  fun canvasBackgroundStaysVisibleWhileVideoTransformAndGapVisibilityStayDeterministic() {
    val plan = parseTimelineRenderPlan(
      mapOf(
        "version" to 1,
        "durationMs" to 2_000,
        "width" to 720,
        "height" to 1_280,
        "videoTransform" to transform(0.5, 0.5, 1.0, 0.0),
        "clips" to listOf(
          mapOf(
            "id" to "clip",
            "uri" to "content://clip",
            "timelineStartMs" to 0,
            "timelineEndMs" to 1_000,
            "sourceStartMs" to 0,
            "sourceEndMs" to 1_000,
            "transform" to transform(0.75, 0.25, 1.5, 30.0),
            "transition" to mapOf("type" to "none", "durationMs" to 0),
          ),
        ),
      ),
    )
    val settings = TimelineVideoCompositorSettings(plan)

    assertEquals(Size(720, 1_280), settings.getOutputSize(listOf(Size(10, 10))))
    assertEquals(0f, settings.getOverlaySettings(0, 500_000).alphaScale)
    val active = settings.getOverlaySettings(1, 500_000)
    assertEquals(1f, active.alphaScale)
    assertEquals(0.5f, active.backgroundFrameAnchor.first)
    assertEquals(0.5f, active.backgroundFrameAnchor.second)
    assertEquals(1.5f, active.scale.first)
    assertEquals(-30f, active.rotationDegrees)
    assertEquals(0f, settings.getOverlaySettings(1, 1_500_000).alphaScale)
    assertEquals(1f, settings.getOverlaySettings(2, 1_500_000).alphaScale)
  }

  @Test
  fun canvasClockOwnsTimestampsWhileFootageRendersAboveBackground() {
    val base = EditedMediaItem.Builder(MediaItem.Builder().setUri("file:///canvas.png").setImageDurationMs(2_000).build())
      .setFrameRate(30).build()
    val footage = EditedMediaItemSequence.withVideoFrom(listOf(
      EditedMediaItem.Builder(MediaItem.fromUri("file:///footage.mp4")).build(),
    ))
    val sequences = clockedVideoSequences(base, footage)
    assertEquals(3, sequences.size)
    assertSame(base, sequences[0].editedMediaItems.single())
    assertSame(footage, sequences[1])
    assertSame(base, sequences[2].editedMediaItems.single())
    assertEquals(1, clockedVideoSequences(base, null).size)
  }

  private fun transform(x: Double, y: Double, scale: Double, rotation: Double) = mapOf<String, Any>(
    "fit" to "fit",
    "position" to mapOf<String, Any>("x" to x, "y" to y),
    "scale" to scale,
    "rotation" to rotation,
  )
}
