package app.captionstudio.media

import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaMetadataRetriever
import android.net.Uri
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowMediaMetadataRetriever
import org.robolectric.shadows.util.DataSource

/** Real native Canvas pixels; only decoded frames/metadata are supplied by Robolectric.
 * App-owned canonical temporary files are policy inputs, NOT decodable MP4 fixtures.
 * This suite makes no codec, Media3 GL compositor, or device/GPU claim.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TimelineTransitionCompositeCanvasTest {
  @Test fun crossfadeHasOpaqueGlobalMatte() = opaqueCanvas("crossfade")
  @Test fun pushLeftHasOpaqueGlobalMatte() = opaqueCanvas("push-left")
  @Test fun pushRightHasOpaqueGlobalMatte() = opaqueCanvas("push-right")
  @Test fun pushUpHasOpaqueGlobalMatte() = opaqueCanvas("push-up")
  @Test fun pushDownHasOpaqueGlobalMatte() = opaqueCanvas("push-down")
  @Test fun zoomInHasOpaqueGlobalMatte() = opaqueCanvas("zoom-in")
  @Test fun zoomOutHasOpaqueGlobalMatte() = opaqueCanvas("zoom-out")
  @Test fun spinHasOpaqueGlobalMatte() = opaqueCanvas("spin")
  @Test fun foldHorizontalHasOpaqueGlobalMatte() = opaqueCanvas("fold-horizontal")
  @Test fun foldVerticalHasOpaqueGlobalMatte() = opaqueCanvas("fold-vertical")
  @Test fun irisCircleHasOpaqueGlobalMatte() = opaqueCanvas("iris-circle")
  @Test fun irisDiamondHasOpaqueGlobalMatte() = opaqueCanvas("iris-diamond")
  @Test fun splitHorizontalHasOpaqueGlobalMatte() = opaqueCanvas("split-horizontal")
  @Test fun splitVerticalHasOpaqueGlobalMatte() = opaqueCanvas("split-vertical")

  private fun opaqueCanvas(type: String) = withOverlay(type) { fixture ->
    listOf(3_700L, 3_850L, 4_000L, 4_150L, 4_299L).forEach { time ->
      val bitmap = fixture.render(time)
      for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
        assertEquals("$type at $time ($x,$y) must own the complete output canvas", 255,
          Color.alpha(bitmap.getPixel(x, y)))
      }
    }
  }

  @Test fun crossfadeFadesIncomingFullCanvasMatteTogetherWithItsPortraitImage() = withOverlay("crossfade") { fixture ->
    val bitmap = fixture.render(4_000)
    // The red landscape occupies y=4..12; the blue portrait occupies x=4..12.
    // At (2,8), incoming content is its matte, not a hole revealing undimmed red.
    assertPixelNear("incoming matte must fade over outgoing red", Color.rgb(144, 32, 48), bitmap.getPixel(2, 8), 2)
    assertPixelNear("actual decoded source colors must also blend", Color.rgb(128, 0, 127), bitmap.getPixel(8, 8), 2)
    assertEquals("outside both images uses the project matte", Color.rgb(32, 64, 96), bitmap.getPixel(1, 1))
  }

  @Test fun incomingMarginsAreAlreadyResolvedJustBeforeTheTransitionEnds() = withOverlay("crossfade") { fixture ->
    val bitmap = fixture.render(4_299)
    // At 599/600 phase the remaining red contribution is <= 1 code value.
    // A global fill alone leaves this margin solid red until the overlay disappears.
    assertPixelNear("no outgoing margin pop on handoff", Color.rgb(32, 64, 96), bitmap.getPixel(2, 8), 2)
    assertPixelNear("incoming portrait remains visible", Color.BLUE, bitmap.getPixel(8, 8), 2)
  }

  @Test fun masksRevealIncomingMatteAsWellAsIncomingImage() {
    listOf("iris-circle", "iris-diamond", "split-horizontal").forEach { type ->
      withOverlay(type) { fixture ->
        val bitmap = fixture.render(4_150)
        // This pixel is well inside each incoming mask but outside its portrait.
        assertEquals("$type must replace outgoing red with incoming matte inside the mask",
          Color.rgb(32, 64, 96), bitmap.getPixel(2, 8))
        assertEquals("$type incoming source center", Color.BLUE, bitmap.getPixel(8, 8))
      }
    }
  }

  @Test fun translatedAndScaledSourcesStillLeaveAnOpaqueGlobalBackground() =
    withOverlay("push-left", transformed = true) { fixture ->
      val bitmap = fixture.render(4_000)
      for (y in 0 until 16) for (x in 0 until 16) {
        assertEquals("transformed source planes must not expose native footage at ($x,$y)",
          255, Color.alpha(bitmap.getPixel(x, y)))
      }
      assertEquals(Color.rgb(32, 64, 96), bitmap.getPixel(8, 0))
    }

  @Test fun translucentDirectNativeBackgroundUsesExistingAndroidArgbResolution() =
    withOverlay("crossfade", background = "#80336699") { fixture ->
      val expected = timelineVideoGapColor("#80336699", true)
      assertEquals(255, Color.alpha(expected))
      assertEquals("direct native input remains Android ARGB, resolved by the existing helper",
        expected, fixture.render(4_000).getPixel(1, 1))
    }

  @Test fun spinMidpointAddsFullWhiteCameraFlashAfterSourceSnapshots() = withOverlay("spin") { fixture ->
    val bitmap = fixture.render(4_000)
    // CameraFlash peak^2 is 1 at phase .5; this must cover images AND margins.
    for (y in 0 until 16) for (x in 0 until 16) {
      assertEquals("spin peak flash at ($x,$y)", Color.WHITE, bitmap.getPixel(x, y))
    }
  }

  @Test fun inactiveCompositeDoesNotTakeOwnershipOfOrdinaryNativeFootage() = withOverlay("crossfade") { fixture ->
    listOf(3_699L, 4_300L).forEach { time ->
      assertEquals("ordinary footage at $time", Color.TRANSPARENT, fixture.render(time).getPixel(8, 8))
    }
  }

  private fun assertPixelNear(message: String, expected: Int, actual: Int, tolerance: Int) {
    assertEquals("$message alpha", Color.alpha(expected), Color.alpha(actual))
    listOf(Color.red(expected) to Color.red(actual), Color.green(expected) to Color.green(actual),
      Color.blue(expected) to Color.blue(actual)).forEach { (want, got) ->
      assertTrue("$message: channel expected $want +/- $tolerance, got $got", kotlin.math.abs(want - got) <= tolerance)
    }
  }

  private class Fixture(val plan: TimelineRenderPlan, val timeline: TimelineTransitionTimeline,
    val overlay: TimelineBitmapOverlay) {
    fun render(timeMs: Long): Bitmap {
      timeline.activeAt(timeMs)?.let { window ->
        registerFrame(window.outgoing, window.outgoingSourceTimeMs(timeMs), 16, 8, Color.RED)
        registerFrame(window.incoming, window.incomingSourceTimeMs(timeMs), 8, 16, Color.BLUE)
      }
      return overlay.getBitmap(timeMs * 1_000)
    }

    private fun registerFrame(clip: RenderVideoClip, sourceTimeMs: Long, width: Int, height: Int, color: Int) {
      val path = requireNotNull(Uri.parse(clip.uri).path)
      val source = DataSource.toDataSource(path)
      ShadowMediaMetadataRetriever.addMetadata(source, MediaMetadataRetriever.METADATA_KEY_DURATION, "4000")
      ShadowMediaMetadataRetriever.addMetadata(source, MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH, width.toString())
      ShadowMediaMetadataRetriever.addMetadata(source, MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT, height.toString())
      ShadowMediaMetadataRetriever.addMetadata(source, MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION, "0")
      // ManagedRetriever recycles each returned frame: register a fresh bitmap on every render.
      val frame = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }
      ShadowMediaMetadataRetriever.addScaledFrame(source, sourceTimeMs.coerceIn(0L, 3_999L) * 1_000,
        width, height, frame)
    }
  }

  private fun withOverlay(type: String, transformed: Boolean = false, background: String = "#204060",
    check: (Fixture) -> Unit) {
    val context = RuntimeEnvironment.getApplication()
    val outgoingFile = File.createTempFile("transition-out-", ".mp4", context.cacheDir).canonicalFile
    val incomingFile = File.createTempFile("transition-in-", ".mp4", context.cacheDir).canonicalFile
    val transform = VideoTransform("fit", 0.5f, 0.5f, 1f, 1f, 1f, 0f)
    var overlay: TimelineBitmapOverlay? = null
    try {
      val outgoing = RenderVideoClip(
        id = "outgoing", uri = Uri.fromFile(outgoingFile).toString(), timelineStartMs = 0, timelineEndMs = 4_000,
        availableSourceStartMs = 0, availableSourceEndMs = 4_000, sourceStartMs = 0, sourceEndMs = 4_000,
        playbackRate = 1f, volume = 1f, muted = false, fadeInMs = 0, fadeOutMs = 0,
        transitionType = type, transitionDurationMs = 600,
        transform = if (transformed) transform.copy(positionX = 0.25f, scale = 0.5f) else transform,
      )
      val incoming = outgoing.copy(id = "incoming", uri = Uri.fromFile(incomingFile).toString(),
        timelineStartMs = 4_000, timelineEndMs = 8_000, transitionType = "none", transitionDurationMs = 0,
        transform = if (transformed) transform.copy(positionX = 0.75f, scale = 0.5f) else transform)
      val plan = TimelineRenderPlan(durationMs = 8_000, width = 16, height = 16, frameRate = 30,
        backgroundColor = background, burnCaptions = false, videoTransform = transform,
        clips = listOf(outgoing, incoming), captions = emptyList(), layers = emptyList(), audioClips = emptyList())
      // Explicitly exercise policy admission; ManagedRetriever repeats this check unchanged.
      plan.clips.forEach { assertEquals(it.uri, MediaInputPolicy(context).requireInput(it.uri).toString()) }
      val timeline = TimelineTransitionTimeline.create(plan.clips, plan.clips.associate { it.uri to 4_000L })
      val created = TimelineBitmapOverlay(context, plan, timeline)
      overlay = created
      check(Fixture(plan, timeline, created))
    } finally {
      try { overlay?.release() } finally {
        ShadowMediaMetadataRetriever.reset()
        outgoingFile.delete()
        incomingFile.delete()
      }
    }
  }
}
