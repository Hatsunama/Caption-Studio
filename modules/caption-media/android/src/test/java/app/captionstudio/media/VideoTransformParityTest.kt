package app.captionstudio.media

import android.graphics.Matrix
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class VideoTransformParityTest {
  @Test
  fun acceptsPreviewRangeAndIndependentAxisScale() {
    val transform = mapOf<String, Any>(
      "fit" to "fit",
      "position" to mapOf<String, Any>("x" to -0.25, "y" to 1.25),
      "scale" to 1.0,
      "scaleX" to 1.5,
      "scaleY" to 0.5,
      "rotation" to 0.0,
    )
    val clip = mapOf<String, Any>(
      "id" to "clip-one", "uri" to "content://clip-one",
      "timelineStartMs" to 0, "timelineEndMs" to 1_000,
      "sourceStartMs" to 0, "sourceEndMs" to 1_000,
      "playbackRate" to 1.0, "volume" to 1.0, "muted" to false,
      "fadeInMs" to 0, "fadeOutMs" to 0,
      "transition" to mapOf<String, Any>("type" to "none", "durationMs" to 0),
      "transform" to transform,
    )
    val plan = parseTimelineRenderPlan(mapOf(
      "version" to 1, "durationMs" to 1_000, "width" to 200, "height" to 200,
      "videoTransform" to transform, "clips" to listOf(clip),
    ))
    assertEquals(-0.25f, plan.clips.single().transform.positionX)
    assertEquals(1.25f, plan.clips.single().transform.positionY)
    assertEquals(1.5f, plan.clips.single().transform.scaleX)
    assertEquals(0.5f, plan.clips.single().transform.scaleY)
  }

  @Test
  fun bitmapTransformUsesSameIndependentAxisScaleAsPreview() {
    val matrix = contentMatrix(
      sourceWidth = 100, sourceHeight = 100,
      targetWidth = 200, targetHeight = 200,
      fit = "fit", positionX = 0.5f, positionY = 0.5f,
      scale = 1f, scaleX = 1.5f, scaleY = 0.5f, rotation = 0f,
    )
    val corners = floatArrayOf(0f, 0f, 100f, 100f)
    matrix.mapPoints(corners)
    assertArrayEquals(floatArrayOf(-50f, 50f, 250f, 150f), corners, 0.001f)
  }
}
