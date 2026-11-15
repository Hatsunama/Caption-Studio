package app.captionstudio.media

import android.os.Handler
import android.os.Looper
import android.graphics.Rect
import android.view.View
import android.view.ViewTreeObserver
import android.view.TextureView
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.Player
import androidx.media3.exoplayer.analytics.AnalyticsListener
import expo.modules.video.VideoView
import expo.modules.video.listeners.VideoPlayerListener
import expo.modules.video.player.VideoPlayer
import java.lang.ref.WeakReference
import java.util.WeakHashMap

/** Presentation exclusion, NOT a submitted-frame receipt. All hierarchy work runs on main. */
@OptIn(UnstableApi::class)
internal class VideoMaskLease : AutoCloseable {
  internal interface Binding {
    fun view(): View?
    fun item(): Any?
    fun output(): Any?
    fun preparedState(): Any?
    fun visible(): Boolean = effectivelyVisible(view())
    fun listen(changed: () -> Unit, released: () -> Unit): AutoCloseable
  }

  internal class NativeBinding(video: VideoPlayer) : Binding {
    private val ref = WeakReference(video)
    override fun view(): View? = ref.get()?.let { player ->
      player.currentVideoView?.takeIf {
        it.playerView.player === player.player && it.playerView.videoSurfaceView is TextureView
      }
    }
    override fun item(): Any? = ref.get()?.player?.currentMediaItem
    override fun output(): Any? = ref.get()?.currentVideoView?.playerView?.videoSurfaceView
      ?.let { (it as? TextureView)?.takeIf { texture -> texture.isAvailable }?.surfaceTexture }
    override fun visible(): Boolean = ref.get()?.currentVideoView?.let {
      view() === it && effectivelyVisible(it.playerView.videoSurfaceView)
    } ?: false
    override fun preparedState(): Any? = ref.get()?.let {
      if (it.player.playerError != null || it.player.playbackState != Player.STATE_READY ||
        !VideoFrameReceipt.NativeHooks(it).layoutValid()) null
      else listOf(it.player.currentPosition, it.player.surfaceSize.width.toLong(), it.player.surfaceSize.height.toLong())
    }
    override fun listen(changed: () -> Unit, released: () -> Unit): AutoCloseable {
      val listener = object : VideoPlayerListener {
        override fun onTargetViewChanged(player: VideoPlayer, newTargetView: VideoView?, oldTargetView: VideoView?) {
          // The SDK's MutableWeakReference reverses the argument labels. Read the binding.
          changed()
        }
      }
      val analytics = object : AnalyticsListener {
        override fun onPlayerReleased(eventTime: AnalyticsListener.EventTime) { released() }
      }
      try {
        ref.get()?.addListener(listener)
        ref.get()?.player?.addAnalyticsListener(analytics)
      } catch (failure: Exception) {
        runCatching { ref.get()?.removeListener(listener) }
        runCatching { ref.get()?.player?.removeAnalyticsListener(analytics) }
        throw failure
      }
      return AutoCloseable {
        runCatching { ref.get()?.removeListener(listener) }
        runCatching { ref.get()?.player?.removeAnalyticsListener(analytics) }
      }
    }
  }

  private val main = Handler(Looper.getMainLooper())
  private val lock = Any()
  // Values contain weak bindings/views, never their weak key or a settled request callback.
  private val owners = WeakHashMap<Any, Owner>()
  private val highest = WeakHashMap<Any, Long>()
  private val cancelledThrough = WeakHashMap<Any, Long>()
  private val maskOwners = WeakHashMap<View, Pair<WeakReference<Owner>, Float>>()
  private var closed = false
  private var suspended = false

  fun resume() = synchronized(lock) { suspended = false }

  fun acquire(video: VideoPlayer, peer: VideoPlayer, id: Double, generation: Double, hidden: Boolean,
              completion: (String?) -> Unit) = acquire(video.player, NativeBinding(video), NativeBinding(peer), id, generation, hidden, completion)

  internal fun acquire(key: Any, binding: Binding, peer: Binding, id: Double, generation: Double, hidden: Boolean,
                       completion: (String?) -> Unit) {
    var settled = false
    val finish: (String?) -> Unit = { code -> synchronized(lock) {
      if (!settled) { settled = true; completion(code) }
    } }
    if (!valid(id) || !valid(generation)) { finish(INVALID); return }
    synchronized(lock) {
      if (closed || suspended || id.toLong() <= (highest[key] ?: 0)) { finish(STALE); return }
      highest[key] = id.toLong()
      main.post {
        synchronized(lock) {
          if (closed || suspended || highest[key] != id.toLong() || id.toLong() <= (cancelledThrough[key] ?: 0)) { finish(STALE); return@post }
          owners.entries.removeAll { !it.value.active }
          if (owners.size >= 32 && !owners.containsKey(key)) { finish(BUSY); return@post }
          try {
            val owner = owners.getOrPut(key) { Owner(binding) }
            owner.begin(id.toLong(), generation.toLong(), peer, hidden, finish)
          } catch (_: Exception) {
            owners[key]?.cancel()
            finish(STALE)
          }
        }
      }
    }
  }

  // Called by the playback-window coordinator on its applicationLooper, immediately after
  // its unchanged source/output/layout receipt succeeds. JS cannot manufacture this checkpoint.
  fun prepared(video: VideoPlayer, id: Double) = prepared(video.player, id)
  internal fun prepared(key: Any, id: Double) = synchronized(lock) {
    owners[key]?.takeIf { highest[key] == id.toLong() }?.let { owner ->
      runCatching { owner.checkpoint(id.toLong()) }.onFailure { owner.cancel() }
    }
  }

  fun commit(video: VideoPlayer, id: Double, generation: Double, completion: (String?) -> Unit) =
    commit(video.player, id, generation, completion)

  internal fun commit(key: Any, id: Double, generation: Double, completion: (String?) -> Unit) {
    main.post {
      synchronized(lock) {
        val owner = owners[key]
        if (!valid(id) || !valid(generation) || closed || suspended || highest[key] != id.toLong() ||
          owner == null || !runCatching { owner.canCommit(id.toLong(), generation.toLong()) }.getOrDefault(false)) completion(STALE)
        else {
          owner.close(restore = true)
          owners.remove(key)
          completion(null)
        }
      }
    }
  }

  fun cancel(video: VideoPlayer, id: Double) = cancel(video.player, id)
  internal fun cancel(key: Any, id: Double) {
    if (!valid(id)) return
    synchronized(lock) {
      if (id.toLong() < (highest[key] ?: 0)) return
      highest[key] = id.toLong() // Synchronous tombstone also blocks queued grants/commits.
      cancelledThrough[key] = id.toLong()
      owners[key]?.cancelled = true
      main.post { synchronized(lock) {
        owners[key]?.takeIf { it.id <= id.toLong() }?.cancel()
      } }
    }
  }

  fun dispose(video: VideoPlayer, id: Double) {
    cancel(video, id)
    main.post { synchronized(lock) {
      owners[video.player]?.takeIf { it.id <= id.toLong() }?.let {
        it.close(restore = false)
        owners.remove(video.player)
      }
    } }
  }

  fun suspend() = synchronized(lock) {
    suspended = true
    owners.values.forEach { it.cancelled = true }
    main.post { synchronized(lock) { owners.values.forEach { it.cancel() } } }
  }

  override fun close() { synchronized(lock) {
    closed = true
    owners.values.forEach { it.cancelled = true }
    main.post { synchronized(lock) {
      owners.values.forEach { it.close(restore = false) }
      owners.clear()
    } }
  } }

  private inner class Owner(private val binding: Binding) {
    var active = true
      private set
    var id = 0L
    private var generation = 0L
    var cancelled = false
    private var granted = false
    private var leaseHeld = false
    private var peer: Binding? = null
    private var hidden = true
    private var completion: ((String?) -> Unit)? = null
    private var checkpointItem: Any? = null
    private var checkpointOutput: Any? = null
    private var checkpointState: Any? = null
    private var checkpointView = WeakReference<View>(null)
    private val masks = WeakHashMap<View, Float>()
    private var observer = WeakReference<ViewTreeObserver>(null)
    private val timeout = Runnable { synchronized(lock) {
      finish(TIMEOUT)
      if (!leaseHeld) close(restore = false)
    } }
    private val draw = ViewTreeObserver.OnPreDrawListener {
      synchronized(lock) { runCatching { update() }.onFailure { cancel() } }
      true // Hierarchy exclusion only; this callback is not GPU/submission proof.
    }
    private val listener = binding.listen({ synchronized(lock) {
      checkpointItem = null
      checkpointOutput = null
      checkpointState = null
      checkpointView.clear()
      // Persistent dirty exclusion is independent of authorization for a renewal.
      // A synchronous SDK rebind must not expose the outstanding replacement.
      runCatching {
        if (leaseHeld && active) binding.view()?.let { mask(it) }
        update()
      }.onFailure { cancel() }
    } }, { synchronized(lock) { close(restore = false) } })

    fun begin(token: Long, epoch: Long, other: Binding, requireHidden: Boolean, done: (String?) -> Unit) {
      finish(STALE)
      id = token; generation = epoch; cancelled = false
      granted = false
      peer = other; hidden = requireHidden; completion = done
      checkpointItem = null; checkpointOutput = null; checkpointState = null; checkpointView.clear()
      main.postDelayed(timeout, 5000)
      update()
    }

    private fun update() {
      check(Looper.myLooper() == Looper.getMainLooper())
      if (!active) return
      val view = binding.view()
      val tree = view?.viewTreeObserver
      if (tree !== observer.get()) {
        observer.get()?.takeIf { it.isAlive }?.removeOnPreDrawListener(draw)
        observer = WeakReference(tree?.takeIf { it.isAlive }?.also { it.addOnPreDrawListener(draw) })
      }
      if (view != null && masks.containsKey(view)) mask(view)
      if (completion == null || cancelled || view == null || !view.isAttachedToWindow) return
      val other = peer?.view()
      if (hidden && (other == null || other === view || !other.isAttachedToWindow ||
          other.windowToken !== view.windowToken || !ancestorMasked(view) ||
          (peer?.visible() != true && !sharedConcealment(view, other)))) return
      // Own the actual SDK VideoView alpha across promise delivery, source install,
      // Fabric updates and synchronous target changes. SDK only writes its texture CHILD alpha.
      mask(view)
      granted = true
      leaseHeld = true
      finish(null)
    }

    private fun mask(view: View) {
      if (!masks.containsKey(view)) masks[view] = maskOwners[view]?.second ?: view.alpha
      maskOwners[view] = Pair(WeakReference(this), masks.getValue(view))
      view.alpha = 0f
    }

    fun checkpoint(token: Long) {
      if (!active || !granted || cancelled || token != id) return
      val view = binding.view() ?: return
      if (view.alpha != 0f || !view.isAttachedToWindow) return
      checkpointItem = binding.item()
      checkpointOutput = binding.output()
      checkpointState = binding.preparedState()
      checkpointView = WeakReference(view)
    }

    fun canCommit(token: Long, epoch: Long): Boolean {
      val view = binding.view() ?: return false
      return active && granted && !cancelled && id == token && generation == epoch &&
        checkpointItem != null && binding.item() === checkpointItem &&
        checkpointOutput != null && binding.output() === checkpointOutput &&
        checkpointState != null && binding.preparedState() == checkpointState &&
        checkpointView.get() === view && view.isAttachedToWindow && view.alpha == 0f
    }

    fun cancel() {
      cancelled = true
      checkpointItem = null; checkpointOutput = null; checkpointState = null; checkpointView.clear()
      finish(STALE)
      // After grant JS may already have queued replaceAsync. Keep the mask through
      // future target changes; no cancellation path is authorized to reveal it.
      if (!leaseHeld) {
        close(restore = false)
      }
    }

    private fun finish(code: String?) {
      val done = completion ?: return
      completion = null; peer = null
      main.removeCallbacks(timeout)
      done(code)
    }

    fun close(restore: Boolean) {
      if (!active) return
      active = false
      cancelled = true
      granted = false
      finish(STALE)
      listener.close()
      observer.get()?.takeIf { it.isAlive }?.removeOnPreDrawListener(draw)
      observer.clear()
      masks.forEach { (view, alpha) ->
        if (maskOwners[view]?.first?.get() === this) {
          if (restore && view.alpha == 0f) view.alpha = alpha
          if (restore) maskOwners.remove(view)
        }
      }
      masks.clear(); checkpointItem = null; checkpointOutput = null; checkpointState = null; checkpointView.clear()
    }
  }

  companion object {
    internal fun ancestorMasked(view: View): Boolean {
      var parent = view.parent as? View
      while (parent != null) {
        if (parent.alpha == 0f) return true
        parent = parent.parent as? View
      }
      return false
    }
    internal fun effectivelyVisible(view: View?): Boolean {
      if (view == null || !view.isAttachedToWindow || !view.isShown || view.windowVisibility != View.VISIBLE ||
        view.width <= 0 || view.height <= 0 || !view.getGlobalVisibleRect(Rect())) return false
      var node: View? = view
      while (node != null) {
        if (node.alpha <= 0f || node.visibility != View.VISIBLE) return false
        node = node.parent as? View
      }
      return true
    }
    // Composite preparation already hides the entire pair until BOTH frame receipts
    // exist. This is different from two siblings temporarily alpha-zero during a
    // Fabric mount: no pixel is newly hidden by acquiring our per-view lease here.
    internal fun sharedConcealment(view: View, peer: View): Boolean {
      var ancestor = view.parent as? View
      while (ancestor != null) {
        if (ancestor.alpha == 0f) {
          var other = peer.parent as? View
          while (other != null) {
            if (other === ancestor) return true
            other = other.parent as? View
          }
        }
        ancestor = ancestor.parent as? View
      }
      return false
    }
    private fun valid(value: Double) = value.isFinite() && value > 0 && value <= 9007199254740991.0 && value == kotlin.math.floor(value)
    private const val STALE = "E_VIDEO_MASK_STALE"
    private const val INVALID = "E_VIDEO_MASK_INVALID"
    private const val BUSY = "E_VIDEO_MASK_BUSY"
    private const val TIMEOUT = "E_VIDEO_MASK_TIMEOUT"
  }
}
