package app.captionstudio.media

import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
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
  private fun start(id: Double = 1.0, end: Double? = 6375.0, expected: String = uri, timeout: Double = 100.0): Reply {
    val reply = Reply()
    owner.configure(fake.player, expected, id, end, timeout, reply, fake::install)
    return reply
  }

  @Test fun clipCopiesMetadataAndBoundsPositionAndClearRestoresFullSource() {
    fake.position = 9000
    val metadata = fake.item.mediaMetadata
    val clipped = start()
    drain()
    assertEquals(6375L, fake.item.clippingConfiguration.endPositionMs)
    assertEquals(0L, fake.item.clippingConfiguration.startPositionMs)
    assertSame(metadata, fake.item.mediaMetadata)
    assertEquals(6374L, fake.position)
    assertEquals(0, clipped.calls)
    fake.ready(); assertEquals(listOf<String?>(null), clipped.results)
    assertTrue(fake.listeners.isEmpty())
    val clear = start(2.0, null); drain()
    assertEquals(MediaItem.ClippingConfiguration.UNSET, fake.item.clippingConfiguration)
    fake.ready(); assertEquals(listOf<String?>(null), clear.results)
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
    val oldListener = fake.listeners.single()
    val second = start(2.0, 6385.0)
    owner.cancel(fake.player, 1.0)
    val older = start(1.0)
    drain()
    assertEquals(listOf("E_VIDEO_WINDOW_STALE"), first.results)
    assertEquals(1, older.calls)
    assertEquals(6385L, fake.item.clippingConfiguration.endPositionMs)
    oldListener.onEvents(fake.player, stateEvent())
    assertEquals(0, second.calls)
    fake.ready()
    assertEquals(listOf<String?>(null), second.results)
    assertEquals(1, first.calls)
  }

  @Test fun staleReadyLabelCannotResolveBufferingAndSameUriReplacementRejects() {
    val reply = start(); drain()
    fake.listeners.single().onEvents(fake.player, stateEvent())
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
    fake.listeners.single().onPlayerError(failure) // stale callback argument alone is insufficient
    assertEquals(0, error.calls)
    fake.failure = failure
    fake.listeners.single().onPlayerError(failure)
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
    other.configure(fake.player, uri, 1.0, 100.0, 100.0, failed) { _, _ -> kotlin.error("private") }
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
    listOf(0.0, 5001.0, Double.NaN).forEach { assertEquals(1, start(timeout = it).calls) }
    drain(); assertEquals(0, fake.installs)
  }

  @Test fun fractionalTimeoutWithinBoundsIsAccepted() {
    val reply = start(timeout = 1.5); drain()
    assertEquals(0, reply.calls)
    fake.ready(); assertEquals(listOf<String?>(null), reply.results)
  }

  @Test fun queuedSupersessionSkipsOldStartAndPreservesForeignListener() {
    val foreign = object : Player.Listener {}
    fake.listeners += foreign
    val old = start()
    val newer = start(2.0)
    drain()
    assertEquals(1, fake.installs)
    assertEquals(listOf("E_VIDEO_WINDOW_STALE"), old.results)
    fake.ready()
    assertEquals(listOf<String?>(null), newer.results)
    assertEquals(listOf(foreign), fake.listeners)
  }

  @Test fun nullOnAlreadyFullSourceStillPreparesAndNeverMeansNotLoaded() {
    val full = start(end = null); drain()
    assertEquals(1, fake.installs)
    assertEquals(MediaItem.ClippingConfiguration.UNSET, fake.item.clippingConfiguration)
    assertEquals(123L, fake.position)
    fake.ready(); assertEquals(listOf<String?>(null), full.results)
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
      Reply().also { owner.configure(candidate.player, uri, 1.0, 100.0, 5000.0, it, candidate::install) }
    }
    assertEquals(32, owner.pendingCount)
    assertEquals(listOf("E_VIDEO_WINDOW_BUSY"), replies.last().results)
    drain()
    owner.close(); drain()
    assertEquals(0, owner.pendingCount)
    assertTrue(players.all { it.listeners.isEmpty() })
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
    val listeners = mutableListOf<Player.Listener>()
    val player = Proxy.newProxyInstance(Player::class.java.classLoader, arrayOf(Player::class.java)) { proxy, method, args ->
      when (method.name) {
        "hashCode" -> System.identityHashCode(proxy)
        "equals" -> proxy === args!![0]
        "getApplicationLooper" -> Looper.getMainLooper()
        else -> {
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
