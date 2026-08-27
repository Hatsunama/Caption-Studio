package app.captionstudio.media

import androidx.media3.common.util.Size
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class TimelineVideoCompositorSettingsTest {
  @Test
  fun transparentClockDrivesOutputWhileVideoTransformAndGapVisibilityStayDeterministic() {
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
    assertEquals(1f, settings.getOverlaySettings(2, 500_000).alphaScale)
  }

  private fun transform(x: Double, y: Double, scale: Double, rotation: Double) = mapOf<String, Any>(
    "fit" to "fit",
    "position" to mapOf<String, Any>("x" to x, "y" to y),
    "scale" to scale,
    "rotation" to rotation,
  )
}
