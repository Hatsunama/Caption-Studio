package app.captionstudio.media

import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import androidx.media3.common.C
import androidx.media3.transformer.Composition
import expo.modules.kotlin.Promise
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/** Executes the production builders, not a second implementation of packing. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], manifest = Config.NONE, shadows = [TimelineAudioLanesTest.AudioExtractor::class])
class TimelineAudioLanesTest {
  @Implements(MediaExtractor::class)
  class AudioExtractor {
    @Implementation fun setDataSource(context: Context, uri: Uri, headers: Map<String, String>?) = Unit
    @Implementation fun getTrackCount(): Int = 1
    @Implementation fun getTrackFormat(index: Int): MediaFormat = MediaFormat.createAudioFormat("audio/aac", 48_000, 2)
    @Implementation fun release() = Unit
  }

  private val context get() = RuntimeEnvironment.getApplication()
  private val transform = VideoTransform("fit", 0.5f, 0.5f, 1f, 1f, 1f, 0f)
  private fun audio(id: Int, start: Long, end: Long) = TimelineAudioSegment(
    "audio-$id", "content://media/audio/$id", start, end, 100, 100 + end - start, 1f, 0.4f, false,
  )
  private fun video(id: Int, transition: Boolean = false) = RenderVideoClip(
    "video-$id", "content://media/video/$id", id * 1_000L, (id + 1) * 1_000L,
    0, 10_000, 2_000, 3_000, 1f, 0.7f, false, 100, 100,
    if (transition) "crossfade" else "none", if (transition) 400 else 0, transform,
  )
  private fun inserted(id: Int, start: Long, duration: Long) = RenderAudioClip(
    "inserted-$id", "content://media/inserted/$id", start, 100, 100 + duration, 1f, 0.3f, false, 100, 100,
  )

  private fun captionComposition(plan: TimelineAudioPlan): Composition {
    val method = TimelineAudioRenderer::class.java.getDeclaredMethod("buildComposition", Context::class.java, TimelineAudioPlan::class.java)
    method.isAccessible = true
    return method.invoke(TimelineAudioRenderer, context, plan) as Composition
  }

  private fun exportComposition(
    clips: List<RenderVideoClip>,
    audioClips: List<RenderAudioClip> = emptyList(),
    durationMs: Long = clips.lastOrNull()?.timelineEndMs ?: 5_000L,
  ): Composition {
    val plan = TimelineRenderPlan(durationMs, 64, 64, 30, "#000000", false, transform, clips, emptyList(), emptyList(), audioClips)
    val durations = clips.associate { it.uri to 10_000L }
    val transitions = TimelineTransitionTimeline.create(clips, durations)
    val overlay = TimelineBitmapOverlay(context, plan, transitions)
    val exporter = TimelineVideoExporter(context)
    val classes = TimelineVideoExporter::class.java.declaredClasses
    val sourceClass = classes.first { it.simpleName == "MediaSourceInfo" }
    val sourceConstructor = sourceClass.declaredConstructors.single().apply { isAccessible = true }
    val sources = durations.mapValues { sourceConstructor.newInstance(it.value, true) }
    val taskClass = classes.first { it.simpleName == "ActiveExport" }
    val stageClass = classes.first { it.simpleName == "ExportStage" }
    val promise = object : Promise {
      override fun resolve(value: Any?) = Unit
      override fun reject(code: String?, message: String?, cause: Throwable?) = Unit
    }
    val constructor = taskClass.declaredConstructors.first { it.parameterCount == 13 }.apply { isAccessible = true }
    val task = constructor.newInstance(
      File(context.cacheDir, "lanes.mp4"), File(context.cacheDir, "base.png"), promise, overlay, transitions, sources,
      null, AtomicBoolean(false), AtomicBoolean(false), AtomicBoolean(false), stageClass.enumConstants.first(), null, null,
    )
    TimelineVideoExporter::class.java.getDeclaredField("activeExport").apply { isAccessible = true }.set(exporter, task)
    try {
      val method = TimelineVideoExporter::class.java.getDeclaredMethod("buildComposition", TimelineRenderPlan::class.java, taskClass).apply { isAccessible = true }
      val prepared = method.invoke(exporter, plan, task)
      return prepared.javaClass.getDeclaredField("composition").apply { isAccessible = true }.get(prepared) as Composition
    } finally {
      overlay.release()
    }
  }

  private fun laneCount(composition: Composition) = composition.sequences.count { C.TRACK_TYPE_AUDIO in it.trackTypes }

  @Test fun caption52SequentialCutsUseOneLane() {
    assertEquals(1, laneCount(captionComposition(TimelineAudioPlan(77_000, List(52) { audio(it, it * 1_000L, (it + 1) * 1_000L) }, emptyList()))))
  }
  @Test fun caption1000SequentialCutsUseOneLane() {
    assertEquals(1, laneCount(captionComposition(TimelineAudioPlan(1_000_000, List(1_000) { audio(it, it * 1_000L, (it + 1) * 1_000L) }, emptyList()))))
  }
  @Test fun captionRealOverlapsUseTwoLanes() {
    val segments = listOf(audio(0, 0, 1_200), audio(1, 800, 2_000), audio(2, 2_000, 3_200), audio(3, 2_800, 4_000))
    assertEquals(2, laneCount(captionComposition(TimelineAudioPlan(4_000, segments, emptyList()))))
  }
  @Test fun export52SequentialCutsUseOneLane() {
    assertEquals(1, laneCount(exportComposition(List(52) { video(it) }, durationMs = 77_000)))
  }
  @Test fun export1000SequentialCutsUseOneLane() {
    assertEquals(1, laneCount(exportComposition(List(1_000) { video(it) })))
  }
  @Test fun exportCustomCrossfadesUseTwoLanes() {
    assertEquals(2, laneCount(exportComposition(List(6) { video(it, it < 5) })))
  }
  @Test fun exportInsertedSequentialAudioSharesAvailableLanes() {
    assertEquals(1, laneCount(exportComposition(emptyList(), List(52) { inserted(it, it * 1_000L, 1_000) }, 77_000)))
  }
  @Test fun exportCrossfadePlusInsertedMixUsesThreeLanes() {
    assertEquals(3, laneCount(exportComposition(List(6) { video(it, it < 5) }, listOf(inserted(0, 0, 6_000)))))
  }
  @Test fun captionPreservesLeadingInternalAndTrailingSilence() {
    val composition = captionComposition(TimelineAudioPlan(5_000, listOf(audio(0, 500, 1_500), audio(1, 2_000, 3_000)), emptyList()))
    assertEquals(1, laneCount(composition))
    val items = composition.sequences.single().editedMediaItems
    assertEquals(listOf(500_000L, 500_000L, 2_000_000L), items.filter { it.mediaItem.localConfiguration == null }.map { it.durationUs })
    assertEquals(listOf(100L, 100L), items.filter { it.mediaItem.localConfiguration != null }.map { it.mediaItem.clippingConfiguration.startPositionMs })
    assertTrue(items.filter { it.mediaItem.localConfiguration != null }.all { it.removeVideo && it.effects.audioProcessors.size == 1 })
  }
}
