package app.captionstudio.media

import android.graphics.Color
import android.graphics.Paint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class TimelineNativeResourceTest {
  @Test
  fun overlayFrameBufferReusesOneBitmapClearsPixelsAndReleasesIt() {
    val buffer = ReusableOverlayBitmap(8, 6)
    val first = buffer.render(Color.RED) {}
    val second = buffer.render(Color.TRANSPARENT) { canvas ->
      canvas.drawRect(0f, 0f, 2f, 2f, Paint().apply { color = Color.BLUE })
    }

    assertSame(first, second)
    assertEquals(Color.BLUE, second.getPixel(0, 0))
    assertEquals(Color.TRANSPARENT, second.getPixel(7, 5))

    buffer.close()
    assertTrue(second.isRecycled)
    assertThrows(IllegalStateException::class.java) { buffer.render(Color.BLACK) {} }
  }

  @Test
  fun explicitUnreadableFontFailsDuringExportPreparation() {
    val plan = parseTimelineRenderPlan(planWithFont("file:///missing-caption-studio-font.ttf"))
    val painter = TimelineTextPainter(RuntimeEnvironment.getApplication())

    val error = assertThrows(IllegalArgumentException::class.java) {
      painter.prepare(listOf(plan.captions.single().style))
    }

    assertTrue(error.message.orEmpty().contains("resolved font", ignoreCase = true))
  }

  private fun planWithFont(uri: String) = mapOf<String, Any>(
    "version" to 1,
    "durationMs" to 1_000,
    "width" to 720,
    "height" to 1_280,
    "videoTransform" to mapOf<String, Any>(
      "fit" to "fit",
      "position" to mapOf<String, Any>("x" to 0.5, "y" to 0.5),
      "scale" to 1,
      "rotation" to 0,
    ),
    "clips" to listOf(
      mapOf<String, Any>(
        "id" to "video",
        "uri" to "content://video",
        "timelineStartMs" to 0,
        "timelineEndMs" to 1_000,
        "sourceStartMs" to 0,
        "sourceEndMs" to 1_000,
        "transition" to mapOf<String, Any>("type" to "none", "durationMs" to 0),
      ),
    ),
    "captions" to listOf(
      mapOf<String, Any>(
        "id" to "caption",
        "text" to "Test",
        "startMs" to 0,
        "endMs" to 1_000,
        "style" to textStyle(uri),
        "words" to emptyList<Map<String, Any>>(),
      ),
    ),
  )

  private fun textStyle(uri: String) = mapOf<String, Any>(
    "font" to mapOf<String, Any>("source" to "imported", "family" to "Missing", "uri" to uri),
    "stroke" to emptyMap<String, Any>(),
    "shadow" to emptyMap<String, Any>(),
    "background" to emptyMap<String, Any>(),
    "position" to mapOf<String, Any>("x" to 0.5, "y" to 0.78),
    "box" to mapOf<String, Any>("width" to 0.86, "height" to 0.2),
    "animation" to emptyMap<String, Any>(),
  )
}
