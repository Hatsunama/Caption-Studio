package app.captionstudio.media

import android.content.Context
import android.media.MediaExtractor
import android.net.Uri
import android.os.Looper
import expo.modules.kotlin.Promise
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], manifest = Config.NONE, shadows = [TimelineAudioRendererTest.BlockingExtractor::class])
@LooperMode(LooperMode.Mode.PAUSED)
class TimelineAudioRendererTest {
  @Implements(MediaExtractor::class)
  class BlockingExtractor {
    companion object {
      var entered = CountDownLatch(1)
      var release = CountDownLatch(1)
    }

    @Implementation
    fun setDataSource(context: Context, uri: Uri, headers: Map<String, String>?) {
      entered.countDown()
      release.await(3, TimeUnit.SECONDS)
    }

    @Implementation
    fun getTrackCount(): Int = 0

    @Implementation
    fun release() = Unit
  }

  private fun segment(id: String, volume: Float = 1f) = TimelineAudioSegment(
    id, "content://$id", 0, 1_000, 0, 1_000, 1f, volume, false,
  )

  @Test
  fun audibleMixAppliesEachSegmentVolume() {
    val gain = TimelineAudioGainProvider(0.35f)
    assertEquals(0.35f, gain.getGainFactorAtSamplePosition(0, 48_000), 0.0001f)
    assertEquals(0.35f, gain.getGainFactorAtSamplePosition(24_000, 48_000), 0.0001f)
  }

  @Test
  fun unreadableAudibleSourceFailsEvenWhenAnotherSourceIsUsable() {
    val plan = TimelineAudioPlan(1_000, listOf(segment("good")), listOf(segment("unreadable")))
    val error = assertThrows(IllegalStateException::class.java) {
      selectAudibleTimelineSegments(plan) { uri ->
        if (uri == "content://unreadable") throw SecurityException("grant revoked")
        true
      }
    }
    assertTrue(error.message.orEmpty().contains("unreadable"))
  }

  @Test
  fun silentVideoIsSkippedButSilentInsertedAudioFails() {
    val videoOnly = TimelineAudioPlan(1_000, listOf(segment("silent-video"), segment("good")), emptyList())
    assertEquals(listOf("good"), selectAudibleTimelineSegments(videoOnly) { it == "content://good" }.map { it.id })
    val inserted = TimelineAudioPlan(1_000, emptyList(), listOf(segment("silent-inserted")))
    assertThrows(IllegalStateException::class.java) { selectAudibleTimelineSegments(inserted) { false } }
  }

  @Test
  fun throwingTransformerCancelStillCleansOutputAndRejectsOnce() {
    var cleanupCount = 0
    var rejectionCount = 0
    finishCancelledTimelineAudioRender(
      cancelTransformer = { throw IllegalStateException("Transformer cancel failed") },
      cleanup = { cleanupCount++ },
      reject = { rejectionCount++ },
    )
    assertEquals(1, cleanupCount)
    assertEquals(1, rejectionCount)
  }

  @Test
  fun cancelledPreflightRetriesNeverCreateUnboundedWorkers() {
    val field = TimelineAudioRenderer::class.java.getDeclaredField("preflightWorkers")
    field.isAccessible = true
    val executor = field.get(TimelineAudioRenderer) as ThreadPoolExecutor
    assertEquals(1, executor.maximumPoolSize)
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val retryStarted = CountDownLatch(1)
    val blocked = executor.submit {
      entered.countDown()
      while (release.count > 0) {
        try { release.await() } catch (_: InterruptedException) { }
      }
    }
    try {
      assertTrue(entered.await(5, TimeUnit.SECONDS))
      val cancelledRetry = executor.submit { throw AssertionError("Cancelled queued retry ran") }
      assertEquals(1, executor.queue.size)
      cancelledRetry.cancel(true)
      executor.purge()
      assertTrue(executor.queue.isEmpty())
      val retry = executor.submit { retryStarted.countDown() }
      assertEquals(1L, retryStarted.count)
      assertEquals(1, executor.activeCount)
      release.countDown()
      blocked.get(5, TimeUnit.SECONDS)
      retry.get(5, TimeUnit.SECONDS)
      assertEquals(0L, retryStarted.count)
    } finally {
      release.countDown()
      blocked.cancel(true)
      executor.purge()
    }
  }

  @Test
  fun blockedAudioProbeDoesNotHoldMainLooperAndCancelSettlesPromise() {
    BlockingExtractor.entered = CountDownLatch(1)
    BlockingExtractor.release = CountDownLatch(1)
    val context = RuntimeEnvironment.getApplication()
    val rejection = AtomicReference<String?>()
    val promise = object : Promise {
      override fun resolve(value: Any?) { throw AssertionError("Cancelled render resolved") }
      override fun reject(code: String?, message: String?, cause: Throwable?) { rejection.set(code) }
    }
    val output = File(context.cacheDir, "blocked-timeline-audio.m4a")
    val plan = TimelineAudioPlan(1_000, emptyList(), listOf(segment("blocked")))
    val fallback = Thread {
      Thread.sleep(1_500)
      BlockingExtractor.release.countDown()
    }
    fallback.start()
    try {
      TimelineAudioRenderer.render(context, output.absolutePath, plan, promise)
      val started = System.nanoTime()
      shadowOf(Looper.getMainLooper()).idle()
      val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
      assertTrue("Main looper was blocked by source probing for ${elapsedMs}ms", elapsedMs < 1_000)
      assertTrue("Audio probe was not reached", BlockingExtractor.entered.await(2, TimeUnit.SECONDS))

      TimelineAudioRenderer.cancel()
      shadowOf(Looper.getMainLooper()).idle()
      assertEquals("E_TIMELINE_AUDIO_CANCELLED", rejection.get())
    } finally {
      BlockingExtractor.release.countDown()
      fallback.join(2_000)
    }
  }
}
