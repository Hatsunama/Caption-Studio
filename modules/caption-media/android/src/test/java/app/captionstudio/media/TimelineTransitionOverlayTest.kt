package app.captionstudio.media

import android.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TimelineTransitionOverlayTest {
  @Test
  fun fadeDarkExportMatchesPreviewBlackCoverAcrossTheCut() {
    val overlay = overlay("fade-dark")
    try {
      // Preview opacity is peak = 1 - abs(phase * 2 - 1), including full black at the cut.
      listOf(3_499L to 0, 3_500L to 0, 3_750L to 127, 4_000L to 255, 4_250L to 127, 4_500L to 0)
        .forEach { (timeMs, alpha) ->
          val bitmap = overlay.getBitmap(timeMs * 1_000)
          for (y in 0 until bitmap.height) {
            for (x in 0 until bitmap.width) {
              assertEquals("fade-dark at $timeMs ms ($x, $y)", Color.argb(alpha, 0, 0, 0), bitmap.getPixel(x, y))
            }
          }
        }
    } finally {
      overlay.release()
    }
  }

  @Test
  fun everyRegisteredCoverDrawsAtTheCutWithoutDecodingCompositeFrames() {
    TimelineTransitionSpec.coverTypes.forEach { type ->
      val overlay = overlay(type)
      try {
        assertTrue(type, Color.alpha(overlay.getBitmap(4_000_000).getPixel(2, 2)) > 0)
      } finally {
        overlay.release()
      }
    }
  }

  @Test
  fun cleanCutsAndZeroDurationTransitionsLeaveTheOverlayTransparent() {
    listOf("none" to 1_000L, "fade-dark" to 0L).forEach { (type, durationMs) ->
      val overlay = overlay(type, durationMs)
      try {
        assertEquals(Color.TRANSPARENT, overlay.getBitmap(4_000_000).getPixel(2, 2))
      } finally {
        overlay.release()
      }
    }
  }

  @Test
  fun unknownActiveTransitionsFailInsteadOfSilentlyExportingAHardCut() {
    listOf("catalog-only-effect", "push-diagonal").forEach { type ->
      val overlay = overlay(type)
      try {
        val error = assertThrows(IllegalArgumentException::class.java) { overlay.getBitmap(4_000_000) }
        assertTrue(error.message.orEmpty().contains("Unsupported video transition: $type"))
      } finally {
        overlay.release()
      }
    }
  }

  private fun overlay(type: String, durationMs: Long = 1_000): TimelineBitmapOverlay {
    val transform = VideoTransform("fit", 0.5f, 0.5f, 1f, 1f, 1f, 0f)
    val outgoing = RenderVideoClip(
      id = "outgoing",
      uri = "content://outgoing",
      timelineStartMs = 0,
      timelineEndMs = 4_000,
      availableSourceStartMs = 0,
      availableSourceEndMs = 4_000,
      sourceStartMs = 0,
      sourceEndMs = 4_000,
      playbackRate = 1f,
      volume = 1f,
      muted = false,
      fadeInMs = 0,
      fadeOutMs = 0,
      transitionType = type,
      transitionDurationMs = durationMs,
      transform = transform,
    )
    val incoming = outgoing.copy(
      id = "incoming", uri = "content://incoming", timelineStartMs = 4_000, timelineEndMs = 8_000,
      transitionType = "none", transitionDurationMs = 0,
    )
    val plan = TimelineRenderPlan(
      durationMs = 8_000, width = 4, height = 4, frameRate = 30,
      backgroundColor = "#000000", burnCaptions = false, videoTransform = transform,
      clips = listOf(outgoing, incoming), captions = emptyList(), layers = emptyList(), audioClips = emptyList(),
    )
    return TimelineBitmapOverlay(
      RuntimeEnvironment.getApplication(), plan,
      TimelineTransitionTimeline.create(plan.clips, mapOf(outgoing.uri to 4_000, incoming.uri to 4_000)),
    )
  }
}
