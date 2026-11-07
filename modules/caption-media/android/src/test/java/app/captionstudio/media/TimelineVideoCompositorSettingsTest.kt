package app.captionstudio.media

import androidx.media3.common.MediaItem
import androidx.media3.common.util.Size
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class TimelineVideoCompositorSettingsTest {
  @Test
  fun expectedTailKeepsFootageOpaqueAndTraceIsNumericBoundedAndFair() {
    val plan = tailPlan()
    val settings = TimelineVideoCompositorSettings(plan)
    ShadowLog.clear()

    settings.getOverlaySettings(1, 5_884_999)
    assertTrue(ShadowLog.getLogsForTag("CS_TAIL_DIAG").isEmpty())
    // Settings evidence only: this does not render or reproduce the encoded black pixels.
    assertEquals(1f, settings.getOverlaySettings(1, 6_333_333).alphaScale)
    assertEquals(0f, settings.getOverlaySettings(0, 6_333_333).alphaScale)
    assertEquals(1f, settings.getOverlaySettings(2, 6_333_333).alphaScale)
    assertEquals(0f, settings.getOverlaySettings(1, 6_385_000).alphaScale)
    val initial = ShadowLog.getLogsForTag("CS_TAIL_DIAG").map { it.msg }
    assertTrue(initial.contains("event=2 inputId=1 inputPTS=6333333 timeMs=6333 clipIndex=0 timelineStartMs=0 timelineEndMs=6385 sourceStartMs=0 sourceEndMs=6385 alpha=1.0"))
    assertTrue(initial.last().contains("clipIndex=-1 timelineStartMs=-1 timelineEndMs=-1 sourceStartMs=-1 sourceEndMs=-1 alpha=0.0"))

    // Exhaust the clock first; footage and background must each retain their own allowance.
    for (input in listOf(0, 1, 2)) {
      repeat(64) { settings.getOverlaySettings(input, 6_333_333) }
    }
    val messages = ShadowLog.getLogsForTag("CS_TAIL_DIAG").map { it.msg }
    assertEquals(48, messages.size)
    for (input in 0..2) assertEquals(16, messages.count { it.contains("inputId=$input ") })
    assertNumericDiagnostics(messages)

    // A fresh compositor gets a fresh budget; out-of-window calls never consume it.
    ShadowLog.clear()
    val fresh = TimelineVideoCompositorSettings(plan)
    fresh.getOverlaySettings(1, 6_886_000)
    assertTrue(ShadowLog.getLogsForTag("CS_TAIL_DIAG").isEmpty())
    fresh.getOverlaySettings(1, 5_885_000)
    assertEquals(1, ShadowLog.getLogsForTag("CS_TAIL_DIAG").size)
    fresh.getOverlaySettings(1, 6_416_667)
    assertTrue(ShadowLog.getLogsForTag("CS_TAIL_DIAG").last().msg.contains(
      "inputPTS=6416667 timeMs=6385 clipIndex=-1"))
  }

  @Test
  fun concurrentTailCallbacksKeepIndependentHardLimits() {
    val settings = TimelineVideoCompositorSettings(tailPlan())
    ShadowLog.clear()
    val start = java.util.concurrent.CountDownLatch(1)
    val workers = List(3) {
      Thread {
        start.await()
        repeat(32) {
          for (input in 0..2) settings.getOverlaySettings(input, 6_333_333)
        }
      }.apply { start() }
    }
    start.countDown()
    workers.forEach { it.join(5_000) }
    assertTrue(workers.none { it.isAlive })
    val messages = ShadowLog.getLogsForTag("CS_TAIL_DIAG").map { it.msg }
    assertEquals(48, messages.size)
    for (input in 0..2) assertEquals(16, messages.count { it.contains("inputId=$input ") })
    assertNumericDiagnostics(messages)
  }

  @Test
  fun nativePlanTraceCapsClipDetailsAndNeverLogsPrivateStrings() {
    val one = tailPlan()
    val plan = one.copy(clips = List(7) { one.clips.single() })
    ShadowLog.clear()
    logTimelineExportTailPlan(plan)
    val messages = ShadowLog.getLogsForTag("CS_TAIL_DIAG").map { it.msg }
    assertEquals(5, messages.size)
    assertEquals("event=0 durationMs=6385 frameRate=24 clipCount=7 layerCount=1 originalAudioCandidateCount=7 insertedAudioCount=0 insertedAudioCandidateCount=0 videoLayerAudioCandidateCount=0", messages.first())
    assertEquals(4, messages.count { it.startsWith("event=1 ") })
    assertTrue(messages.last().contains("clipIndex=3 "))
    assertTrue(messages.last().endsWith("rate=1.0 transitionNone=1 transitionDurationMs=0"))
    assertNumericDiagnostics(messages)
  }

  private fun assertNumericDiagnostics(messages: List<String>) {
    val scalarRecord = Regex("[A-Za-z][A-Za-z0-9]*=-?[0-9]+(?:\\.[0-9]+)?(?: [A-Za-z][A-Za-z0-9]*=-?[0-9]+(?:\\.[0-9]+)?)*")
    messages.forEach { message ->
      assertTrue(message, scalarRecord.matches(message))
      for (privateValue in listOf("content://private-tail-uri", "private-tail-id", "private-tail-text")) {
        assertTrue(message, !message.contains(privateValue))
      }
    }
  }

  private fun tailPlan() = parseTimelineRenderPlan(mapOf(
    "version" to 1,
    "durationMs" to 6_385,
    "frameRate" to 24,
    "width" to 720,
    "height" to 1_280,
    "videoTransform" to transform(0.5, 0.5, 1.0, 0.0),
    "clips" to listOf(mapOf(
      "id" to "private-tail-id",
      "uri" to "content://private-tail-uri",
      "timelineStartMs" to 0,
      "timelineEndMs" to 6_385,
      "sourceStartMs" to 0,
      "sourceEndMs" to 6_385,
      "transition" to mapOf("type" to "none", "durationMs" to 0),
    )),
    "layers" to listOf(mapOf(
      "kind" to "text",
      "id" to "private-tail-id",
      "text" to "private-tail-text",
      "startMs" to 0,
      "endMs" to 6_385,
      "style" to mapOf("font" to emptyMap<String, Any>(), "stroke" to emptyMap<String, Any>(),
        "shadow" to emptyMap<String, Any>(), "background" to emptyMap<String, Any>(),
        "position" to emptyMap<String, Any>(), "box" to emptyMap<String, Any>(), "animation" to emptyMap<String, Any>()),
    )),
  ))

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
