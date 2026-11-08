package app.captionstudio.media

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.ExperimentalApi
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import expo.modules.video.player.VideoPlayer
import java.util.WeakHashMap

/** Owns preparation requests only; Expo retains the player, surface, clock and SDK listeners. */
@OptIn(UnstableApi::class, ExperimentalApi::class)
internal class VideoPlaybackWindow : AutoCloseable {
  fun interface Completion { fun complete(errorCode: String?) }

  private val lock = Any()
  // Values never reference their weak keys. Tokens survive completion/cancel, not player lifetime.
  private val highest = WeakHashMap<Player, Long>()
  private val pending = mutableMapOf<Player, Request>()
  private var closed = false
  internal val pendingCount: Int get() = synchronized(lock) { pending.size }

  fun configure(
    video: VideoPlayer, expectedUri: String, requestId: Double, endMs: Double?,
    targetMs: Double, timeoutMs: Double, completion: Completion,
  ) {
    val player = video.player
    configure(player, expectedUri, requestId, endMs, targetMs, timeoutMs, completion,
      { item, target, current, changed -> VideoFrameReceipt(player, item, target, VideoFrameReceipt.NativeHooks(video), current, changed) },
    ) { item, position ->
      // Called only on applicationLooper. URI-string local sources have no SDK HTTP/cache/DRM
      // responsibilities to reconstruct. Unsupported native item configurations fail closed.
      // Expo clears uncommittedSource on successful SDK load. Its committed source is private;
      // the caller contract admits only already-approved URI-string local sources, not sources
      // with headers/cache/DRM options. A staged SDK replacement must win over this operation.
      require(video.uncommittedSource == null)
      val mediaSource = sourceFactory(video.context).createMediaSource(item)
      player.pause()
      player.setMediaSource(mediaSource, position)
      player.prepare() // Exactly one native prepare; do not call VideoPlayer.prepare().
    }
  }

  internal fun configure(
    player: Player, expectedUri: String, requestId: Double, endMs: Double?, targetMs: Double, timeoutMs: Double,
    completion: Completion, frames: (MediaItem, Long, () -> Boolean, () -> Unit) -> VideoFrameReceipt, install: (MediaItem, Long) -> Unit,
  ) {
    if (!safePositiveInteger(requestId) ||
      (endMs != null && (!positiveInteger(endMs) || endMs > MAX_CLOCK_MS)) ||
      !targetMs.isFinite() || targetMs < 0 || targetMs > MAX_CLOCK_MS || (endMs != null && targetMs >= endMs) ||
      !timeoutMs.isFinite() || timeoutMs < 1 || timeoutMs > 5000) {
      completion.complete(INVALID); return
    }
    synchronized(lock) {
      val token = requestId.toLong()
      if (closed || token <= (highest[player] ?: 0L)) {
        completion.complete(STALE); return
      }
      highest[player] = token
      pending[player]?.retire(STALE)
      // A hard limit bounds strong player retention while preparation is pending.
      if (pending.size >= 32 && !pending.containsKey(player)) { completion.complete(BUSY); return }
      val request = Request(player, expectedUri, token, endMs?.toLong(), targetMs.toLong(), kotlin.math.ceil(timeoutMs).toLong(), completion, frames, install)
      pending[player] = request
      if (!request.handler.post(request.start)) request.finish(STALE)
    }
  }

  fun cancel(video: VideoPlayer, requestId: Double) = cancel(video.player, requestId)

  internal fun cancel(player: Player, requestId: Double) {
    require(safePositiveInteger(requestId)) { "Invalid playback window request" }
    synchronized(lock) {
      val token = requestId.toLong()
      val previous = highest[player] ?: 0L
      if (token < previous) return
      highest[player] = token
      pending[player]?.takeIf { it.token <= token }?.retire(STALE)
    }
  }

  override fun close() {
    synchronized(lock) {
      closed = true
      pending.values.toList().forEach { it.retire(STALE) }
    }
  }

  private inner class Request(
    val player: Player, val expectedUri: String, val token: Long, val endMs: Long?, val targetMs: Long,
    val timeoutMs: Long, val completion: Completion,
    val frames: (MediaItem, Long, () -> Boolean, () -> Unit) -> VideoFrameReceipt, val install: (MediaItem, Long) -> Unit,
  ) {
    val handler = Handler(player.applicationLooper)
    private var done = false
    private var retired = false
    private var listening = false
    private var prepared = false
    private var installed: MediaItem? = null
    private var receipt: VideoFrameReceipt? = null
    // PRIVATE never-merge numeric CSV. 1 start, 2 install, 3 evaluate, 4 timeout, 5 finish.
    // kind,event,row,token,playerId,endMs,targetMs,position,state,error,itemMatch,live,code,receipt...
    private var probeRows = 0
    private fun probe(event: Int, code: String? = null) {
      runCatching {
        if (probeRows >= 120 || (event == 3 && probeRows >= 110)) return
        probeRows++
        val live = Looper.myLooper() == handler.looper && !done && !retired && isCurrent()
        val bucket = when (code) { null -> 0; STALE -> 1; INVALID -> 2; BUSY -> 3; TIMEOUT -> 4; PLAYER_ERROR -> 5; else -> 6 }
        Log.i("CSResumeDiag", listOf(2, event, probeRows, token, System.identityHashCode(player), endMs ?: -1L, targetMs,
          if (live) player.currentPosition else -1L, if (live) player.playbackState else -1,
          if (live) if (player.playerError != null) 1 else 0 else -1,
          if (live) if (player.currentMediaItem === installed) 1 else 0 else -1,
          if (live) 1 else 0, bucket).joinToString(",") + "," + (receipt?.diagnosticSnapshot() ?: "-1"))
      }
    }
    private val timeout = Runnable {
      synchronized(lock) {
        probe(4)
        val matches = runCatching { isCurrent() && player.currentMediaItem === installed }.getOrDefault(false)
        finish(if (matches) TIMEOUT else STALE)
      }
    }
    private val listener = object : Player.Listener {
      override fun onEvents(player: Player, events: Player.Events) {
        synchronized(lock) {
          if (done || retired || !prepared) return
          evaluate()
        }
      }
      override fun onPlayerError(error: PlaybackException) {
        synchronized(lock) {
          if (done || retired || !prepared) return
          try {
            if (!isCurrent() || player.currentMediaItem !== installed) finish(STALE)
            else if (player.playerError != null) finish(PLAYER_ERROR)
          } catch (_: Exception) { finish(PLAYER_ERROR) }
        }
      }
    }
    val start = Runnable {
      synchronized(lock) {
        if (done || retired) return@synchronized
        probe(1)
        if (!isCurrent()) { finish(STALE); return@synchronized }
        try {
          val current = player.currentMediaItem
          if (current?.localConfiguration?.uri?.toString() != expectedUri) {
            finish(STALE); return@synchronized
          }
          requireNotNull(current)
          val item = copyItem(current, expectedUri, endMs)
          installed = item
          player.addListener(listener)
          listening = true
          receipt = frames(item, targetMs, { synchronized(lock) { !done && !retired && isCurrent() } }) {
            synchronized(lock) { if (!done && !retired && prepared) evaluate() }
          }
          handler.postDelayed(timeout, timeoutMs)
          probe(2)
          install(item, targetMs)
          prepared = true
          evaluate() // READY alone never completes; the installed target needs all frame receipts.
        } catch (_: Exception) { finish(PLAYER_ERROR) }
      }
    }

    private fun evaluate() {
      probe(3)
      try {
        if (!isCurrent() || player.currentMediaItem !== installed) finish(STALE)
        else if (player.playerError != null) finish(PLAYER_ERROR)
        else if (player.playbackState == Player.STATE_READY && receipt?.isPresented() == true) finish(null)
      } catch (_: Exception) { finish(PLAYER_ERROR) }
    }

    private fun isCurrent() = !closed && highest[player] == token && pending[player] === this

    fun retire(code: String) {
      if (done || retired) return
      retired = true // synchronous tombstone blocks queued starts before looper cleanup
      handler.removeCallbacks(start)
      handler.removeCallbacks(timeout)
      handler.post { synchronized(lock) { finish(code) } }
    }

    fun finish(code: String?) {
      if (done) return
      probe(5, code)
      done = true
      handler.removeCallbacks(start)
      handler.removeCallbacks(timeout)
      if (listening) runCatching { player.removeListener(listener) }
      listening = false
      receipt?.close()
      receipt = null
      if (pending[player] === this) pending.remove(player)
      completion.complete(code)
    }
  }

  companion object {
    // Safe in both JS and Media3 millisecond-to-microsecond clock conversions.
    private const val MAX_CLOCK_MS = 9007199254740991.0
    private const val STALE = "E_VIDEO_WINDOW_STALE"
    private const val INVALID = "E_VIDEO_WINDOW_INVALID"
    private const val BUSY = "E_VIDEO_WINDOW_BUSY"
    private const val TIMEOUT = "E_VIDEO_WINDOW_TIMEOUT"
    private const val PLAYER_ERROR = "E_VIDEO_WINDOW_PLAYER"
    private fun positiveInteger(value: Double) = value.isFinite() && value > 0 && value == kotlin.math.floor(value)
    private fun safePositiveInteger(value: Double) = positiveInteger(value) && value <= 9007199254740991.0

    internal fun sourceFactory(context: Context): DefaultMediaSourceFactory =
      DefaultMediaSourceFactory(context).setDataSourceFactory(DefaultDataSource.Factory(context))
        .setEnableClippingInMediaPeriod(true)

    internal fun copyItem(current: MediaItem, expectedUri: String, endMs: Long?): MediaItem {
      val local = requireNotNull(current.localConfiguration)
      require(local.uri.toString() == expectedUri)
      // Import/recovery owns MediaInputPolicy approval of the already loaded asset. Do not
      // canonicalize files/open providers on the UI thread or admit any new URI here.
      require((local.uri.scheme == "file" && local.uri.authority.isNullOrEmpty() &&
        local.uri.query == null && local.uri.fragment == null && local.uri.path?.startsWith("/") == true) ||
        (local.uri.scheme == "content" && !local.uri.authority.isNullOrBlank()))
      require(local.drmConfiguration == null && local.customCacheKey == null && local.adsConfiguration == null)
      val clip = current.clippingConfiguration
      require(clip.startPositionUs == 0L && !clip.relativeToDefaultPosition && !clip.relativeToLiveWindow)
      return current.buildUpon().setClippingConfiguration(
        if (endMs == null) MediaItem.ClippingConfiguration.UNSET
        else MediaItem.ClippingConfiguration.Builder().setStartPositionMs(0).setEndPositionMs(endMs).build(),
      ).build()
    }
  }
}
