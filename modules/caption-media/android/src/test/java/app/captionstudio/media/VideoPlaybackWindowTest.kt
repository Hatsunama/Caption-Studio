package app.captionstudio.media

import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.SinglePeriodTimeline
import expo.modules.video.listeners.VideoPlayerListener
import expo.modules.video.player.VideoPlayer
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.lang.reflect.Proxy
import java.time.Duration

/** Coordinator/source contract tests; physical decoder EOF still requires both phones. */
@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
class VideoPlaybackWindowTest {
  private val uri = "content://documents/approved"
  private val owner = VideoPlaybackWindow()
  private val fake = FakePlayer()
  private fun drain() = shadowOf(Looper.getMainLooper()).idle()
  private fun stateEvent() = Player.Events(androidx.media3.common.FlagSet.Builder()
    .add(Player.EVENT_PLAYBACK_STATE_CHANGED).build())
  private fun start(id: Double = 1.0, end: Double = 6375.0, expected: String = uri, timeout: Double = 100.0, target: Double = 123.0): Reply {
    val reply = Reply()
    owner.configure(fake.player, expected, id, end, target, timeout, reply, fake::frames, fake::install)
    return reply
  }

  @Test fun readyAloneMustNotResolveWithoutPresentedFrame() {
    val reply = start(); drain()
    fake.ready()
    assertEquals(0, reply.calls)
  }

  @Test fun readyAndPresentedFrameCanArriveInEitherOrderWithSdkBeforeOrAfterOutput() {
    listOf(true, false).forEachIndexed { index, sdkFirst ->
      val readyFirst = start(id = index * 2.0 + 1); drain()
      fake.ready(); assertEquals(0, readyFirst.calls)
      fake.frame(sdkFirst); assertEquals(listOf<String?>(null), readyFirst.results)
      val frameFirst = start(id = index * 2.0 + 2); drain()
      fake.frame(sdkFirst); assertEquals(0, frameFirst.calls)
      fake.ready(); assertEquals(listOf<String?>(null), frameFirst.results)
    }
  }

  @Test fun rejectsOldSourceAndOldOutputAndSdkAloneEvenWhenReady() {
    val oldItem = fake.item
    val reply = start(); drain(); fake.ready()
    fake.sdkFrame(); fake.outputFrame()
    assertEquals(0, reply.calls)
    fake.analyticsFrame(oldItem); fake.sdkFrame(); fake.outputFrame()
    assertEquals(0, reply.calls)
    // Analytics also sees frames for detached outputs. Media3 emits no Player callback for these.
    fake.analyticsFrame(); fake.sdkFrame()
    assertEquals(0, reply.calls)
    // A subsequent stale-source frame must replace, not inherit, the candidate.
    fake.analyticsFrame(oldItem); fake.outputFrame(); fake.sdkFrame()
    assertEquals(0, reply.calls)
    fake.frame(); assertEquals(listOf<String?>(null), reply.results)
  }

  @Test fun deferredSdkLayoutReceiptNeedsMatchingFrameAndValidLayout() {
    fake.layoutValid = false
    val reply = start(); drain(); fake.ready()
    fake.analyticsFrame(); fake.outputFrame(); fake.sdkFrame()
    assertEquals(0, reply.calls)
    fake.layoutValid = true
    fake.resize() // Layout state alone is not Expo's first-frame receipt.
    assertEquals(0, reply.calls)
    fake.sdkFrame()
    assertEquals(listOf<String?>(null), reply.results)
  }

  @Test fun sdkDeduplicationAllowsAnotherGenuineFrameOnSameBindingBeforeReady() {
    val reply = start(); drain()
    fake.frame()
    assertEquals(0, reply.calls)
    fake.analyticsFrame(); fake.outputFrame() // Expo emits once per item/view.
    fake.ready()
    assertEquals(listOf<String?>(null), reply.results)
  }

  @Test fun sameViewSurfaceLossNeedsFreshCurrentOutputButNotAnotherSdkReceipt() {
    listOf(0 to 0, 0 to 180, 320 to 0).forEachIndexed { index, lostSize ->
      val reply = start(id = index + 1.0); drain()
      val view = fake.view
      fake.frame(sdkFirst = index % 2 == 0) // All receipts while BUFFERING.
      assertEquals(0, reply.calls)
      fake.layoutValid = false
      fake.resize(lostSize.first, lostSize.second)
      fake.layoutValid = true
      fake.resize()
      fake.ready()
      assertSame(view, fake.view)
      assertEquals("Restoring size and READY must not reuse the destroyed output", 0, reply.calls)
      fake.sdkFrame() // A deferred SDK event alone cannot restore the output evidence.
      assertEquals(0, reply.calls)
      fake.analyticsFrame() // Detached-output analytics gets no Player first-frame callback.
      assertEquals(0, reply.calls)
      // Another loss must invalidate even this incomplete candidate on the same view.
      fake.layoutValid = false; fake.resize(0, 0)
      fake.layoutValid = true; fake.resize()
      assertEquals(0, reply.calls)
      fake.analyticsFrame()
      assertEquals(0, reply.calls)
      fake.outputFrame() // Expo may deduplicate the SDK event.
      assertEquals(listOf<String?>(null), reply.results)
      assertTrue(fake.listeners.isEmpty()); assertTrue(fake.analytics.isEmpty()); assertTrue(fake.sdk.isEmpty())
    }
  }

  @Test fun positiveSurfaceResizeRetainsPairedReceiptWithoutAnotherFirstFrame() {
    val reply = start(); drain()
    fake.frame()
    fake.layoutValid = false; fake.resize(640, 360)
    fake.ready()
    assertEquals(0, reply.calls)
    fake.layoutValid = true; fake.resize(640, 360)
    assertEquals(listOf<String?>(null), reply.results)
  }

  @Test fun sameViewSurfaceLossDoesNotExtendTimeoutOrReusePairedReceiptAfterRebind() {
    val timed = start(); drain(); fake.frame()
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(90))
    fake.layoutValid = false; fake.resize(0, 0)
    fake.layoutValid = true; fake.resize(); fake.ready()
    assertEquals(0, timed.calls)
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(10))
    assertEquals(listOf("E_VIDEO_WINDOW_TIMEOUT"), timed.results)
    assertTrue(fake.listeners.isEmpty()); assertTrue(fake.analytics.isEmpty()); assertTrue(fake.sdk.isEmpty())

    val rebound = start(2.0); drain(); fake.frame()
    fake.layoutValid = false; fake.resize(0, 0)
    fake.rebind()
    fake.layoutValid = true; fake.resize(); fake.ready()
    fake.analyticsFrame(); fake.outputFrame()
    assertEquals("The old view's SDK receipt cannot cross a rebind", 0, rebound.calls)
    fake.sdkFrame()
    assertEquals(listOf<String?>(null), rebound.results)
  }

  @Test fun endedWithAllFrameReceiptsStillDoesNotSatisfyReady() {
    val reply = start(); drain()
    fake.frame()
    fake.state = Player.STATE_ENDED
    fake.listeners.toList().forEach { it.onEvents(fake.player, stateEvent()) }
    assertEquals(0, reply.calls)
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
    assertEquals(listOf("E_VIDEO_WINDOW_TIMEOUT"), reply.results)
  }

  @Test fun releaseWhilePendingMakesFrameCallbacksFailOnceAndDetachOwnedObservers() {
    val reply = start(); drain()
    val sdk = fake.sdk.single()
    fake.released = true
    fake.analyticsFrame()
    assertEquals(listOf("E_VIDEO_WINDOW_PLAYER"), reply.results)
    sdk.onRenderedFirstFrame(fake.sdkSender)
    assertEquals(1, reply.calls)
    assertTrue(fake.listeners.isEmpty()); assertTrue(fake.analytics.isEmpty()); assertTrue(fake.sdk.isEmpty())
    assertEquals(0, owner.pendingCount)
  }

  @Test fun rebindInvalidatesOldViewIncludingDeferredSdkReceiptAndKeepsOriginalBudget() {
    val reply = start(); drain(); fake.ready()
    fake.layoutValid = false
    fake.analyticsFrame(); fake.outputFrame()
    fake.rebind()
    fake.layoutValid = true
    fake.sdkFrame(); fake.resize()
    assertEquals(0, reply.calls)
    fake.analyticsFrame(); fake.sdkFrame() // New source/view, still no current-output receipt.
    assertEquals(0, reply.calls)
    fake.outputFrame()
    assertEquals(listOf<String?>(null), reply.results)

    val timed = start(2.0); drain(); fake.ready()
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(90))
    fake.rebind()
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(10))
    assertEquals(listOf("E_VIDEO_WINDOW_TIMEOUT"), timed.results)
    assertTrue(fake.analytics.isEmpty()); assertTrue(fake.sdk.isEmpty())
  }

  @Test fun resizeCannotCompleteUntilLayoutIsValidAndFrameIsForInstalledTarget() {
    val reply = start(target = 9.875); drain()
    assertEquals(9L, fake.position)
    fake.frame()
    fake.layoutValid = false
    fake.ready(); fake.resize()
    assertEquals(0, reply.calls)
    fake.layoutValid = true
    fake.position = 10
    fake.resize(); fake.frame()
    assertEquals(0, reply.calls)
    fake.position = 9
    fake.frame()
    assertEquals(listOf<String?>(null), reply.results)
  }

  @Test fun cancellationAndBackgroundCloseGuardFrameListenerSnapshotsAndPreserveForeignListeners() {
    val foreignPlayer = object : Player.Listener {}
    val foreignAnalytics = object : AnalyticsListener {}
    val foreignSdk = object : VideoPlayerListener {}
    fake.listeners += foreignPlayer; fake.analytics += foreignAnalytics; fake.sdk += foreignSdk
    val first = start(); drain(); fake.ready()
    val oldOutput = fake.listeners.last()
    val oldSdk = fake.sdk.last()
    val oldAnalytics = fake.analytics.last()
    val second = start(2.0)
    // The old request is synchronously tombstoned, before listener cleanup runs.
    oldOutput.onRenderedFirstFrame()
    oldSdk.onTargetViewChanged(fake.sdkSender, null, null)
    oldSdk.onRenderedFirstFrame(fake.sdkSender)
    drain()
    assertEquals(listOf("E_VIDEO_WINDOW_STALE"), first.results)
    fake.ready()
    fake.analyticsFrame(listener = oldAnalytics)
    oldOutput.onRenderedFirstFrame(); oldSdk.onRenderedFirstFrame(fake.sdkSender)
    assertEquals(0, second.calls)
    owner.cancel(fake.player, 2.0)
    fake.frame(); assertEquals(0, second.calls)
    drain(); assertEquals(listOf("E_VIDEO_WINDOW_STALE"), second.results)

    val background = start(3.0); drain(); fake.ready()
    val releasedOutput = fake.listeners.last()
    val releasedSdk = fake.sdk.last()
    val releasedAnalytics = fake.analytics.last()
    owner.close(); drain()
    // Released-player getters must not be accessed by snapshots after close.
    fake.released = true
    releasedOutput.onRenderedFirstFrame()
    releasedOutput.onSurfaceSizeChanged(320, 180)
    releasedSdk.onRenderedFirstFrame(fake.sdkSender)
    releasedSdk.onTargetViewChanged(fake.sdkSender, null, null)
    fake.analyticsFrame(listener = releasedAnalytics)
    assertEquals(listOf("E_VIDEO_WINDOW_STALE"), background.results)
    assertEquals(listOf(foreignPlayer), fake.listeners)
    assertEquals(listOf(foreignAnalytics), fake.analytics)
    assertEquals(listOf(foreignSdk), fake.sdk)
    assertEquals(0, owner.pendingCount)
  }

  @Test fun clipCopiesMetadataAndInstallsRequestedTargetInsteadOfOldPosition() {
    fake.position = 9000
    val metadata = fake.item.mediaMetadata
    val clipped = start()
    drain()
    assertEquals(6375L, fake.item.clippingConfiguration.endPositionMs)
    assertEquals(0L, fake.item.clippingConfiguration.startPositionMs)
    assertSame(metadata, fake.item.mediaMetadata)
    assertEquals(123L, fake.position)
    assertEquals(0, clipped.calls)
    fake.ready(); assertEquals(0, clipped.calls)
    fake.frame(); assertEquals(listOf<String?>(null), clipped.results)
    assertTrue(fake.listeners.isEmpty())
    val next = start(2.0, 6385.0, target = 6384.999); drain()
    assertEquals(6385L, fake.item.clippingConfiguration.endPositionMs)
    assertEquals(6384L, fake.position)
    fake.ready(); assertEquals(0, next.calls)
    fake.frame(); assertEquals(listOf<String?>(null), next.results)
    assertEquals(2, fake.installs)
    assertEquals(0, owner.pendingCount)
  }

  @Test fun cancellationBeforeQueuedStartLeavesTombstone() {
    val reply = start()
    owner.cancel(fake.player, 1.0)
    drain()
    assertEquals(0, fake.installs)
    assertEquals(listOf("E_VIDEO_WINDOW_STALE"), reply.results)
    val late = start(); drain()
    assertEquals(1, late.calls); assertEquals(0, fake.installs)
    owner.cancel(fake.player, 3.0)
    val preCancelled = start(3.0); drain()
    assertEquals(1, preCancelled.calls); assertEquals(0, fake.installs)
  }

  @Test fun supersessionAndOldCancelCannotTouchNewRequest() {
    val first = start(); drain()
    val oldListener = fake.listeners.first()
    val second = start(2.0, 6385.0)
    owner.cancel(fake.player, 1.0)
    val older = start(1.0)
    drain()
    assertEquals(listOf("E_VIDEO_WINDOW_STALE"), first.results)
    assertEquals(1, older.calls)
    assertEquals(6385L, fake.item.clippingConfiguration.endPositionMs)
    oldListener.onEvents(fake.player, stateEvent())
    assertEquals(0, second.calls)
    fake.ready(); fake.frame()
    assertEquals(listOf<String?>(null), second.results)
    assertEquals(1, first.calls)
  }

  @Test fun staleReadyLabelCannotResolveBufferingAndSameUriReplacementRejects() {
    val reply = start(); drain()
    fake.listeners.first().onEvents(fake.player, stateEvent())
    assertEquals(0, reply.calls)
    fake.item = fake.item.buildUpon().build() // same URI and cap, different generation
    fake.ready()
    assertEquals(listOf("E_VIDEO_WINDOW_STALE"), reply.results)
    assertTrue(fake.listeners.isEmpty())
  }

  @Test fun wrongUriAndUnsupportedSourceNeverInstall() {
    val wrong = start(expected = "content://documents/other"); drain()
    assertEquals(listOf("E_VIDEO_WINDOW_STALE"), wrong.results); assertEquals(0, fake.installs)
    fake.item = MediaItem.fromUri("https://example.invalid/private")
    val network = start(2.0, expected = "https://example.invalid/private"); drain()
    assertEquals(1, network.calls); assertEquals(0, fake.installs)
    fake.item = MediaItem.Builder().setUri(uri).setClippingConfiguration(
      MediaItem.ClippingConfiguration.Builder().setStartPositionMs(1).build()).build()
    val nonzero = start(3.0); drain()
    assertEquals(1, nonzero.calls); assertEquals(0, fake.installs)
  }

  @Test fun timeoutErrorDestroyAndInstallerFailureSettleOnceAndCleanOwnedWork() {
    val timeout = start(); drain()
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
    assertEquals(listOf("E_VIDEO_WINDOW_TIMEOUT"), timeout.results)
    assertTrue(fake.listeners.isEmpty())
    val error = start(2.0); drain()
    val failure = PlaybackException("secret", null, 1000)
    fake.listeners.first().onPlayerError(failure) // stale callback argument alone is insufficient
    assertEquals(0, error.calls)
    fake.failure = failure
    fake.listeners.first().onPlayerError(failure)
    assertEquals(listOf("E_VIDEO_WINDOW_PLAYER"), error.results)
    fake.failure = null
    val destroy = start(3.0)
    owner.close(); drain()
    assertEquals(listOf("E_VIDEO_WINDOW_STALE"), destroy.results)
    assertTrue(fake.listeners.isEmpty()); assertEquals(0, owner.pendingCount)
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(6))
    assertEquals(1, timeout.calls); assertEquals(1, error.calls); assertEquals(1, destroy.calls)
    val closed = start(4.0); assertEquals(1, closed.calls)
    val other = VideoPlaybackWindow()
    val failed = Reply()
    other.configure(fake.player, uri, 1.0, 100.0, 0.0, 100.0, failed, fake::frames) { _, _ -> kotlin.error("private") }
    drain(); assertEquals(listOf("E_VIDEO_WINDOW_PLAYER"), failed.results)
    assertTrue(fake.listeners.isEmpty()); assertEquals(0, other.pendingCount)
  }

  @Test fun invalidNumbersFailBeforeQueuingOrTouchingPlayer() {
    listOf(0.0, -1.0, 1.5, Double.NaN, Double.POSITIVE_INFINITY, 9007199254740992.0).forEach {
      assertEquals(1, start(id = it).calls)
    }
    listOf(0.0, -1.0, 1.5, Double.NaN, Double.POSITIVE_INFINITY, Double.MAX_VALUE).forEach {
      assertEquals(1, start(end = it).calls)
    }
    listOf(-0.1, 6375.0, 6375.1, Double.NaN, Double.POSITIVE_INFINITY).forEach {
      assertEquals(1, start(target = it).calls)
    }
    listOf(0.0, 5001.0, Double.NaN).forEach { assertEquals(1, start(timeout = it).calls) }
    drain(); assertEquals(0, fake.installs)
  }

  @Test fun fractionalTimeoutWithinBoundsIsAccepted() {
    val reply = start(timeout = 1.5); drain()
    assertEquals(0, reply.calls)
    fake.ready(); fake.frame(); assertEquals(listOf<String?>(null), reply.results)
  }

  @Test fun queuedSupersessionSkipsOldStartAndPreservesForeignListener() {
    val foreign = object : Player.Listener {}
    fake.listeners += foreign
    val old = start()
    val newer = start(2.0)
    drain()
    assertEquals(1, fake.installs)
    assertEquals(listOf("E_VIDEO_WINDOW_STALE"), old.results)
    fake.ready(); fake.frame()
    assertEquals(listOf<String?>(null), newer.results)
    assertEquals(listOf(foreign), fake.listeners)
  }

  @Test fun zeroTargetRetainsAbsoluteStartZeroClock() {
    val full = start(target = 0.999); drain()
    assertEquals(1, fake.installs)
    assertEquals(0L, fake.item.clippingConfiguration.startPositionMs)
    assertEquals(0L, fake.position)
    fake.ready(); fake.frame(); assertEquals(listOf<String?>(null), full.results)
  }

  @Test fun sourceReplacementBeforeStartCannotBeInstalledAndReplacementAtTimeoutIsStale() {
    val before = start()
    fake.item = MediaItem.fromUri("content://documents/replacement")
    drain()
    assertEquals(listOf("E_VIDEO_WINDOW_STALE"), before.results)
    assertEquals(0, fake.installs)
    fake.item = MediaItem.fromUri(uri)
    val after = start(2.0); drain()
    fake.item = MediaItem.fromUri("content://documents/replacement")
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
    assertEquals(listOf("E_VIDEO_WINDOW_STALE"), after.results)
    assertTrue(fake.listeners.isEmpty()); assertEquals(0, owner.pendingCount)
  }

  @Test fun pendingLimitBoundsPlayersAndDestroyCleansEveryOwnedRequest() {
    val players = (0..32).map { FakePlayer() }
    val replies = players.map { candidate ->
      Reply().also { owner.configure(candidate.player, uri, 1.0, 100.0, 0.0, 5000.0, it, candidate::frames, candidate::install) }
    }
    assertEquals(32, owner.pendingCount)
    assertEquals(listOf("E_VIDEO_WINDOW_BUSY"), replies.last().results)
    drain()
    owner.close(); drain()
    assertEquals(0, owner.pendingCount)
    assertTrue(players.all { it.listeners.isEmpty() })
    assertTrue(players.all { it.analytics.isEmpty() && it.sdk.isEmpty() })
    assertTrue(replies.all { it.calls == 1 })
  }

  private class Reply : VideoPlaybackWindow.Completion {
    val results = mutableListOf<String?>()
    val calls get() = results.size
    override fun complete(errorCode: String?) { results += errorCode }
  }

  private inner class FakePlayer {
    var item = MediaItem.Builder().setUri(uri).setMediaId("sdk-id").setMediaMetadata(
      MediaMetadata.Builder().setTitle("preserved").build()).build()
    var position = 123L
    var state = Player.STATE_READY
    var installs = 0
    var failure: PlaybackException? = null
    var released = false
    val listeners = mutableListOf<Player.Listener>()
    val analytics = mutableListOf<AnalyticsListener>()
    val sdk = mutableListOf<VideoPlayerListener>()
    var view: Any? = Any()
    var layoutValid = true
    // A typed event sender only: no player methods or resources are used by these callbacks.
    // Android's compile stubs omit this JVM test utility. Resolve it only in the
    // Robolectric JVM; this shell is passed as an event identity and never called.
    private val allocatorClass = Class.forName("sun.misc.Unsafe")
    private val allocator = allocatorClass.getDeclaredField("theUnsafe").let {
      it.isAccessible = true; it.get(null)
    }
    val sdkSender = allocatorClass.getMethod("allocateInstance", Class::class.java)
      .invoke(allocator, VideoPlayer::class.java) as VideoPlayer
    private val hooks = object : VideoFrameReceipt.Hooks {
      override fun currentView(): Any? = view
      override fun layoutValid() = layoutValid
      override fun addAnalytics(listener: AnalyticsListener) { analytics += listener }
      override fun removeAnalytics(listener: AnalyticsListener) { analytics -= listener }
      override fun addSdk(listener: VideoPlayerListener) { sdk += listener }
      override fun removeSdk(listener: VideoPlayerListener) { sdk -= listener }
    }
    fun frames(item: MediaItem, target: Long, current: () -> Boolean, changed: () -> Unit) =
      VideoFrameReceipt(player, item, target, hooks, current, changed)
    fun analyticsFrame(source: MediaItem = item, output: Any = Any(), listener: AnalyticsListener? = null) {
      val timeline = SinglePeriodTimeline(10_000_000L, true, false, false, null, source)
      val period = MediaSource.MediaPeriodId(timeline.getUidOfPeriod(0))
      val event = AnalyticsListener.EventTime(0, timeline, 0, period, position, timeline, 0, period, position, 0)
      (listener?.let { listOf(it) } ?: analytics.toList()).forEach { it.onRenderedFirstFrame(event, output, 0) }
    }
    fun outputFrame() { listeners.toList().forEach { it.onRenderedFirstFrame() } }
    fun sdkFrame() { sdk.toList().forEach { it.onRenderedFirstFrame(sdkSender) } }
    fun frame(sdkFirst: Boolean = true) {
      analyticsFrame()
      if (sdkFirst) { sdkFrame(); outputFrame() } else { outputFrame(); sdkFrame() }
    }
    fun rebind() {
      view = Any()
      sdk.toList().forEach { it.onTargetViewChanged(sdkSender, null, null) }
    }
    fun resize(width: Int = 320, height: Int = 180) {
      listeners.toList().forEach { it.onSurfaceSizeChanged(width, height) }
    }

    val player = Proxy.newProxyInstance(Player::class.java.classLoader, arrayOf(Player::class.java)) { proxy, method, args ->
      when (method.name) {
        "hashCode" -> System.identityHashCode(proxy)
        "equals" -> proxy === args!![0]
        "getApplicationLooper" -> Looper.getMainLooper()
        else -> {
          check(!released || method.name == "removeListener") { "Frame callback touched released player" }
          assertSame(Looper.getMainLooper(), Looper.myLooper())
          when (method.name) {
            "getCurrentMediaItem" -> item
            "getCurrentPosition" -> position
            "getPlaybackState" -> state
            "getPlayerError" -> failure
            "addListener" -> { listeners += args!![0] as Player.Listener; null }
            "removeListener" -> { listeners -= args!![0] as Player.Listener; null }
            else -> throw AssertionError("Unexpected player call: ${method.name}")
          }
        }
      }
    } as Player
    fun install(value: MediaItem, positionMs: Long) {
      installs++; item = value; position = positionMs; state = Player.STATE_BUFFERING
    }
    fun ready() {
      state = Player.STATE_READY
      listeners.toList().forEach { it.onEvents(player, stateEvent()) }
    }
  }
}
