package app.captionstudio.media

import android.graphics.Rect
import android.view.SurfaceView
import android.view.TextureView
import android.view.ViewGroup
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.View
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.analytics.AnalyticsListener
import expo.modules.video.VideoView
import expo.modules.video.enums.PlayerStatus
import expo.modules.video.listeners.VideoManagerListener
import expo.modules.video.listeners.VideoPlayerListener
import expo.modules.video.managers.VideoManager
import expo.modules.video.player.VideoPlayer
import expo.modules.video.records.PlaybackError
import expo.modules.video.records.VideoSource
import java.lang.ref.WeakReference
import java.util.WeakHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** PRIVATE diagnostic branch only. Passive receipts, never proof of visible pixels.
 * CSNativeViewDiag CSV v2 (all fields numeric):
 * version,event,globalRow,viewRow,elapsedRealtimeMs,viewId,observedBindingId,extra1,extra2,
 * currentBindingId,currentViewId,playerViewPlayerId,exoPlayerId,state,positionMs,errorBit,
 * videoW,videoH,PARFloatBits,surfaceW,surfaceH,shouldHideSurfaceBit,surfaceAlphaFloatBits,
 * viewW,viewH,attachedBit,shownBit,mediaItemId,surfaceViewId,exoShutter(-1/null,0,1).
 * Events: 1 register,2 attach,3 layout,4 rebind,5 raw Player first frame,
 * 6 analytics output,7 SDK first frame,8 SDK source,9 SDK status,10 surface,
 * 11 video size,12 target view,13 discontinuity,14 foreground,15 background,
 * 16 dispose,17 detach,18 media item,19 Player state,20 delayed consumer.
 * Event 20 appends SDKSnapshot.consumer() after the original 30-column prefix;
 * other events retain the original width, but version is 2 throughout.
 * Event 20 extras: original trigger event / requested delayMs (not actual latency).
 * Triggered by register/attach/layout/SDK first frame/foreground; coalesced, never
 * restarted while a burst is pending. Three reads at 0/250/1000ms on the existing
 * main Handler, not a layout/frame/compositor fence. Canceled on background/detach,
 * dispose/close; max 24 bursts per registration, 4000 posts per module lifetime.
 * SurfaceTexture identity/timestamp/availability are read at sample time only.
 * Timestamp is the last latched image, not producer progress or screenshot proof.
 * Ancestor index/Z are ordering hints, not proof of sibling/compositor occlusion.
 * Extras: 6 outputId/eventTimelineItemId; 8 sourceId/oldSourceId;
 * 9 statusOrdinal/errorBit; 10,11 width/height; 12 declared new/old view IDs
 * (SDK MutableWeakReference labels reversed; currentView getter is authoritative);
 * 13 reason/0; 18 itemId/reason; 19 state/0; otherwise 0/0.
 * IDs are identityHashCode only, null=0. No URI, metadata or error text.
 * Caps: 120 rows per live registration, 4000 across all views in this module lifetime;
 * reaching a cap drops rows and prevents further consumer reads/posts only. Float fields encode IEEE-754 raw bits as signed ints.
 * SDK status ordinals: 0 idle,1 loading,2 ready,3 error (installed 57.0.5).
 * Off-main callbacks are dropped; no native snapshot is read from those callbacks.
 * Callback snapshots reflect dispatch order; SDK shutter changes may occur later.
 * Discovery is event-driven: binding before attach/layout, earlier callbacks, and
 * silent rebinds with no subsequent observed event are not guaranteed captured.
 */
@OptIn(UnstableApi::class)
internal class PrivateVideoViewProbe(private val boundary: Boundary = NativeBoundary()) : AutoCloseable {
  // Fake only the Android/SDK boundary in tests; lifecycle, binding, caps and CSV stay real.
  internal interface Boundary {
    fun isMain(): Boolean
    fun post(action: () -> Unit)
    // Must enqueue (including delay=0), never invoke inline. Cancellation runs on main.
    fun postDelayed(delayMs: Long, action: () -> Unit): () -> Unit
    fun consumerSnapshot(view: Any): LongArray
    fun manager(registered: (Any) -> Unit, unregistered: (Any) -> Unit, app: (Int) -> Unit): () -> Unit
    fun view(view: Any, event: (Int) -> Unit): () -> Unit
    fun binding(view: Any): Any?
    fun player(player: Any, event: (Int, Int, Int) -> Unit): () -> Unit
    fun snapshot(view: Any): LongArray
    fun now(): Long
    fun log(csv: String)
  }

  private class Entry(view: Any) {
    val view = WeakReference(view)
    var binding = WeakReference<Any>(null)
    var removeView: (() -> Unit)? = null
    var removePlayer: (() -> Unit)? = null
    var rows = 0
    var disposed = false
    var rebindQueued = false
    var generation = 0
    val delayed = mutableListOf<() -> Unit>()
    var burstGeneration = 0
    var bursts = 0
  }

  private val closed = AtomicBoolean(false) // Terminal generation guard, including queued start.
  private var started = false
  private var removeManager: (() -> Unit)? = null
  private val entries = WeakHashMap<Any, Entry>() // Values/cleanup closures never retain their keys.
  private var rows = 0
  private var delayedPosts = 0

  fun start() {
    boundary.post {
      check(boundary.isMain())
      if (closed.get() || started) return@post
      started = true
      removeManager = boundary.manager(::registered, ::unregistered) { event ->
        if (live()) entries.values.toList().forEach { observe(it, event) }
      }
    }
  }

  private fun live() = boundary.isMain() && !closed.get()

  private fun registered(view: Any) {
    if (!live() || entries.containsKey(view)) return
    val entry = Entry(view)
    entries[view] = entry
    entry.removeView = boundary.view(view) { event ->
      if (live() && !entry.disposed) {
        // View attach/layout dispatch is independent of SDK player listener dispatch.
        bind(entry)
        observe(entry, event)
      }
    }
    bind(entry)
    observe(entry, 1)
  }

  private fun unregistered(view: Any) {
    if (!boundary.isMain()) return
    entries.remove(view)?.let { dispose(it) }
  }

  private fun bind(entry: Entry) {
    if (!live() || entry.disposed) return
    val view = entry.view.get() ?: return
    val next = boundary.binding(view)
    if (next === entry.binding.get()) return
    val generation = ++entry.generation
    entry.removePlayer?.invoke()
    entry.removePlayer = null
    entry.binding = WeakReference(next)
    if (next != null) entry.removePlayer = boundary.player(next) { event, a, b ->
      if (live() && !entry.disposed && generation == entry.generation) observe(entry, event, a, b)
    }
    observe(entry, 4)
  }

  private fun observe(entry: Entry, event: Int, a: Int = 0, b: Int = 0) {
    if (!boundary.isMain() || (closed.get() && event != 16) || entry.disposed) return
    if (event == 15 || event == 17) cancelDelayed(entry)
    val view = entry.view.get() ?: return
    // Never add/remove SDK listeners inline during its callbacks (including at caps).
    if (!closed.get() && boundary.binding(view) !== entry.binding.get() && !entry.rebindQueued) {
      entry.rebindQueued = true
      boundary.post {
        entry.rebindQueued = false
        if (live() && !entry.disposed) bind(entry)
      }
    }
    if (entry.rows >= 120 || rows >= 4000) return
    // Snapshot and logging failures must not interrupt SDK dispatch. No exception text.
    runCatching {
      val snapshot = boundary.snapshot(view) +
        if (event == 20) boundary.consumerSnapshot(view) else longArrayOf()
      entry.rows++
      rows++
      boundary.log((longArrayOf(2, event.toLong(), rows.toLong(), entry.rows.toLong(), boundary.now(),
        id(view).toLong(), id(entry.binding.get()).toLong(), a.toLong(), b.toLong()) + snapshot).joinToString(","))
    }
    if (event == 1 || event == 2 || event == 3 || event == 7 || event == 14) scheduleConsumer(entry, event)
  }

  private fun cancelDelayed(entry: Entry) {
    entry.burstGeneration++ // Reject copied callbacks even after another burst starts.
    entry.delayed.forEach { it() }
    entry.delayed.clear()
  }

  private fun scheduleConsumer(entry: Entry, trigger: Int) {
    if (!live() || entry.disposed || entry.view.get() == null || entry.delayed.isNotEmpty() ||
      entry.rows >= 120 || rows >= 4000 || entry.bursts >= 24 || delayedPosts + 3 > 4000) return
    entry.bursts++
    val generation = ++entry.burstGeneration
    // Closures retain Entry only: its view/binding and native cleanup targets are weak.
    runCatching {
      longArrayOf(0, 250, 1000).forEachIndexed { index, delay ->
        delayedPosts++
        entry.delayed += boundary.postDelayed(delay) {
          if (!live() || entry.disposed || generation != entry.burstGeneration || entry.view.get() == null) return@postDelayed
          if (entry.rows >= 120 || rows >= 4000) {
            cancelDelayed(entry)
            return@postDelayed
          }
          observe(entry, 20, trigger, delay.toInt())
          if (index == 2) entry.delayed.clear() // Finite burst; no self rearm.
        }
      }
    }.onFailure { cancelDelayed(entry) }
  }

  private fun dispose(entry: Entry) {
    if (entry.disposed) return
    cancelDelayed(entry)
    observe(entry, 16)
    entry.disposed = true // Reject callbacks already copied by SDK before removals.
    entry.removePlayer?.invoke()
    entry.removeView?.invoke()
    entry.removePlayer = null
    entry.removeView = null
    entry.binding.clear()
    entry.view.clear()
  }

  override fun close() {
    if (!closed.compareAndSet(false, true)) return
    boundary.post {
      check(boundary.isMain())
      removeManager?.invoke()
      removeManager = null
      entries.values.toList().forEach(::dispose)
      entries.clear()
    }
  }

  private class NativeBoundary : Boundary {
    private val mainLooperHandler = Handler(Looper.getMainLooper())
    override fun isMain() = Looper.myLooper() == Looper.getMainLooper()
    override fun post(action: () -> Unit) { mainLooperHandler.post { action() } }
    override fun postDelayed(delayMs: Long, action: () -> Unit): () -> Unit {
      val task = Runnable { action() }
      mainLooperHandler.postDelayed(task, delayMs)
      return { mainLooperHandler.removeCallbacks(task) }
    }
    override fun consumerSnapshot(view: Any) = SDKSnapshot.consumer((view as VideoView).playerView.videoSurfaceView)
    override fun now() = SystemClock.elapsedRealtime()
    override fun log(csv: String) { Log.i("CSNativeViewDiag", csv) }

    override fun manager(registered: (Any) -> Unit, unregistered: (Any) -> Unit, app: (Int) -> Unit): () -> Unit {
      val listener = object : VideoManagerListener {
        override fun onVideoViewRegistered(videoView: VideoView, allVideoViews: Collection<VideoView>) = registered(videoView)
        override fun onVideoViewUnregistered(videoView: VideoView, allVideoViews: Collection<VideoView>) = unregistered(videoView)
        override fun onAppForegrounded() = app(14)
        override fun onAppBackgrounded() = app(15)
      }
      VideoManager.registerListener(listener)
      // Strongly owned by module -> probe -> cleanup; SDK manager only stores weak refs.
      return { VideoManager.unregisterListener(listener) }
    }

    override fun view(view: Any, event: (Int) -> Unit): () -> Unit {
      val target = view as VideoView
      val weak = WeakReference(target)
      val attach = object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(v: View) = event(2)
        override fun onViewDetachedFromWindow(v: View) = event(17)
      }
      val layout = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> event(3) }
      target.addOnAttachStateChangeListener(attach)
      target.addOnLayoutChangeListener(layout)
      return {
        weak.get()?.let { it.removeOnAttachStateChangeListener(attach); it.removeOnLayoutChangeListener(layout) }
      }
    }

    override fun binding(view: Any): Any? = (view as VideoView).videoPlayer

    override fun player(player: Any, event: (Int, Int, Int) -> Unit): () -> Unit {
      val video = player as VideoPlayer
      val weak = WeakReference(video)
      val raw = object : Player.Listener {
        override fun onRenderedFirstFrame() = event(5, 0, 0)
        override fun onSurfaceSizeChanged(width: Int, height: Int) = event(10, width, height)
        override fun onVideoSizeChanged(videoSize: VideoSize) = event(11, videoSize.width, videoSize.height)
        override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) = event(13, reason, 0)
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) = event(18, id(mediaItem), reason)
        override fun onPlaybackStateChanged(playbackState: Int) = event(19, playbackState, 0)
      }
      val analytics = object : AnalyticsListener {
        override fun onRenderedFirstFrame(eventTime: AnalyticsListener.EventTime, output: Any, renderTimeMs: Long) {
          if (!isMain()) return
          // Reading-source identity from the callback timeline, never a URI or track.
          val item = runCatching {
            val index = eventTime.mediaPeriodId?.let { eventTime.timeline.getIndexOfPeriod(it.periodUid) } ?: -1
            if (index < 0) null else {
              val period = eventTime.timeline.getPeriod(index, Timeline.Period())
              eventTime.timeline.getWindow(period.windowIndex, Timeline.Window()).mediaItem
            }
          }.getOrNull()
          event(6, id(output), id(item))
        }
      }
      val sdk = object : VideoPlayerListener {
        override fun onRenderedFirstFrame(player: VideoPlayer) = event(7, 0, 0)
        override fun onSourceChanged(player: VideoPlayer, source: VideoSource?, oldSource: VideoSource?) = event(8, id(source), id(oldSource))
        override fun onStatusChanged(player: VideoPlayer, status: PlayerStatus, oldStatus: PlayerStatus?, error: PlaybackError?) = event(9, status.ordinal, bit(error != null))
        override fun onTargetViewChanged(player: VideoPlayer, newTargetView: VideoView?, oldTargetView: VideoView?) = event(12, id(newTargetView), id(oldTargetView))
      }
      val remove = {
        weak.get()?.let {
          runCatching { it.player.removeListener(raw) }
          runCatching { it.player.removeAnalyticsListener(analytics) }
          runCatching { it.removeListener(sdk) }
        }
        Unit
      }
      // A released player must not make a diagnostic registration fail app work.
      runCatching {
        video.player.addListener(raw)
        video.player.addAnalyticsListener(analytics)
        video.addListener(sdk)
      }.onFailure { remove() }
      return remove
    }

    override fun snapshot(view: Any): LongArray {
      val v = view as VideoView
      val video = v.videoPlayer
      val p = video?.player
      val size = p?.videoSize
      val surface = p?.surfaceSize
      return longArrayOf(id(video).toLong(), id(video?.currentVideoView).toLong(), id(v.playerView.player).toLong(),
        id(p).toLong(), p?.playbackState?.toLong() ?: -1, p?.currentPosition ?: -1,
        bit(p?.playerError != null).toLong(), size?.width?.toLong() ?: -1, size?.height?.toLong() ?: -1,
        size?.pixelWidthHeightRatio?.toRawBits()?.toLong() ?: -1,
        surface?.width?.toLong() ?: -1, surface?.height?.toLong() ?: -1,
        bit(v.shouldHideSurfaceView).toLong(), v.playerView.videoSurfaceView?.alpha?.toRawBits()?.toLong() ?: -1,
        v.width.toLong(), v.height.toLong(), bit(v.isAttachedToWindow).toLong(), bit(v.isShown).toLong(),
        id(p?.currentMediaItem).toLong(), id(v.playerView.videoSurfaceView).toLong(),
        v.useExoShutter?.let { bit(it).toLong() } ?: -1)
    }
  }

  /** Actual native getter path used by NativeBoundary; callable without constructing Expo.
   * Header (7): kind (0 null/1 TextureView/2 SurfaceView/3 other), available (-1 N/A),
   * textureId (0 null), timestampNs (-1 unknown), textureReadErrorBit, nodeCount, truncatedBit.
   * Then nodeCount records of 30 fields, starting at the surface, max 8 nodes:
   * id,parentId,attached,shown,visibility,windowVisibility,w,h,alphaBits,zBits,
   * translationXBits,translationYBits,globalVisibleBit,globalL,T,R,B,
   * clipPresentBit,clipL,T,R,B,clipChildren(-1 N/A),clipToPadding(-1 N/A),
   * indexInParent(-1 N/A),parentChildCount(-1 N/A),left,top,scrollX,scrollY.
   * Global rect is zero when globalVisibleBit=0; absent local clip is also zero.
   * Eight nodes bound the numeric row below the Android log payload limit.
   * No accumulated rect/alpha is synthesized: each ancestor's raw getters are recorded.
   * No SurfaceTexture listener, updateTexImage, bitmap, pixel or View mutation.
   */
  internal object SDKSnapshot {
    fun consumer(surface: View?): LongArray {
      val fields = ArrayList<Long>(7 + 8 * 30)
      val textureView = surface as? TextureView
      var available = -1L
      var textureId = 0L
      var timestamp = -1L
      var textureError = 0L
      if (textureView != null) {
        runCatching { available = bit(textureView.isAvailable).toLong() }.onFailure { textureError = 1 }
        runCatching {
          val texture = textureView.surfaceTexture
          textureId = id(texture).toLong()
          if (texture != null) timestamp = texture.timestamp
        }.onFailure { textureError = 1 }
      }
      fields.addAll(listOf(when (surface) {
        null -> 0L
        is TextureView -> 1L
        is SurfaceView -> 2L
        else -> 3L
      }, available, textureId, timestamp, textureError, 0L, 0L))
      var node = surface
      var count = 0
      val global = Rect()
      while (node != null && count < 8) {
        val current = node
        val parent = current.parent
        val group = parent as? ViewGroup
        global.setEmpty()
        val visible = current.getGlobalVisibleRect(global)
        if (!visible) global.setEmpty()
        val clip = current.clipBounds
        val ownGroup = current as? ViewGroup
        fields.addAll(listOf(id(current).toLong(), id(parent).toLong(), bit(current.isAttachedToWindow).toLong(),
          bit(current.isShown).toLong(), current.visibility.toLong(), current.windowVisibility.toLong(),
          current.width.toLong(), current.height.toLong(), current.alpha.toRawBits().toLong(), current.z.toRawBits().toLong(),
          current.translationX.toRawBits().toLong(), current.translationY.toRawBits().toLong(), bit(visible).toLong(),
          global.left.toLong(), global.top.toLong(), global.right.toLong(), global.bottom.toLong(), bit(clip != null).toLong(),
          clip?.left?.toLong() ?: 0, clip?.top?.toLong() ?: 0, clip?.right?.toLong() ?: 0, clip?.bottom?.toLong() ?: 0,
          ownGroup?.let { bit(it.clipChildren).toLong() } ?: -1, ownGroup?.let { bit(it.clipToPadding).toLong() } ?: -1,
          group?.indexOfChild(current)?.toLong() ?: -1, group?.childCount?.toLong() ?: -1,
          current.left.toLong(), current.top.toLong(), current.scrollX.toLong(), current.scrollY.toLong()))
        count++
        node = parent as? View
      }
      fields[5] = count.toLong()
      fields[6] = bit(node != null).toLong()
      return fields.toLongArray()
    }
  }

  private companion object {
    fun id(value: Any?) = if (value == null) 0 else System.identityHashCode(value)
    fun bit(value: Boolean) = if (value) 1 else 0
  }
}
