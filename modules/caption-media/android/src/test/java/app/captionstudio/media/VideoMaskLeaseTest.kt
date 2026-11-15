package app.captionstudio.media

import android.app.Activity
import android.os.Looper
import android.view.View
import android.widget.FrameLayout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.time.Duration

/** Real production observer, Android hierarchy/alpha and main-looper scheduling through its binding seam. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 28], manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
class VideoMaskLeaseTest {
  private class Binding(var node: View) : VideoMaskLease.Binding {
    var source: Any? = Any()
    var surface: Any? = Any()
    var frameState: Any? = Any()
    val observers = mutableSetOf<() -> Unit>()
    val releases = mutableSetOf<() -> Unit>()
    override fun view(): View = node
    override fun item(): Any? = source
    override fun output(): Any? = surface
    override fun preparedState(): Any? = frameState
    override fun listen(changed: () -> Unit, released: () -> Unit): AutoCloseable {
      observers.add(changed)
      releases.add(released)
      return AutoCloseable { observers.remove(changed); releases.remove(released) }
    }
    fun rebind(view: View) { node = view; observers.toList().forEach { it() } }
  }
  private class Fixture : AutoCloseable {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().visible()
    val context = activity.get()
    val root = FrameLayout(context)
    val parent = FrameLayout(context)
    val outgoing = View(context)
    val incoming = View(context)
    val owner = VideoMaskLease()
    val key = Any()
    val binding = Binding(outgoing)
    val peer = Binding(incoming)
    val replies = mutableListOf<String?>()
    init {
      context.setContentView(root)
      root.addView(parent, FrameLayout.LayoutParams(100, 100))
      parent.addView(outgoing, FrameLayout.LayoutParams(100, 100))
      root.addView(incoming, FrameLayout.LayoutParams(100, 100))
      root.measure(View.MeasureSpec.makeMeasureSpec(100, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(100, View.MeasureSpec.EXACTLY))
      root.layout(0, 0, 100, 100)
      parent.alpha = 0f
    }
    fun drain() = shadowOf(Looper.getMainLooper()).idle()
    fun draw() { root.viewTreeObserver.dispatchOnPreDraw() }
    fun acquire(id: Double = 1.0, epoch: Double = 1.0) {
      owner.acquire(key, binding, peer, id, epoch, true) { replies.add(it) }
      drain()
    }
    fun commit(id: Double = 1.0, epoch: Double = 1.0): List<String?> {
      val result = mutableListOf<String?>()
      owner.commit(key, id, epoch) { result.add(it) }; drain()
      return result
    }
    override fun close() { owner.close(); drain(); activity.pause().stop().destroy() }
  }

  @Test fun grantOwnsAlphaAcrossAncestorRevealUntilNativePreparationCheckpoint() = Fixture().use { f ->
    f.acquire()
    assertEquals(listOf<String?>(null), f.replies)
    assertEquals(0f, f.outgoing.alpha)
    f.parent.alpha = 1f; f.draw()
    assertEquals(0f, f.outgoing.alpha)
    assertEquals(listOf("E_VIDEO_MASK_STALE"), f.commit())
    f.owner.prepared(f.key, 1.0)
    assertEquals(listOf<String?>(null), f.commit())
    assertEquals(1f, f.outgoing.alpha)
    assertTrue(f.binding.observers.isEmpty())
  }

  @Test fun maskedIncomingPeerCannotAuthorizeAllHiddenHandoff() = Fixture().use { f ->
    f.incoming.alpha = 0f
    f.acquire()
    assertTrue(f.replies.isEmpty())
    assertEquals(1f, f.outgoing.alpha)
    f.draw(); assertTrue(f.replies.isEmpty())
    f.incoming.alpha = 1f; f.draw()
    assertEquals(listOf<String?>(null), f.replies)
    assertEquals(0f, f.outgoing.alpha)
  }

  @Test fun sharedCompositeConcealmentAllowsPreparationWithoutRequiringVisiblePeer() = Fixture().use { f ->
    f.parent.alpha = 1f
    f.root.alpha = 0f // Actual COMMON ancestor, not separately masked layers.
    f.acquire()
    assertEquals(listOf<String?>(null), f.replies)
    assertEquals(0f, f.outgoing.alpha)
    f.root.alpha = 1f; f.draw() // Lease persists if Fabric reveals the common parent early.
    assertEquals(0f, f.outgoing.alpha)
    f.owner.prepared(f.key, 1.0)
    assertEquals(listOf<String?>(null), f.commit())
    assertEquals(1f, f.outgoing.alpha)
  }

  @Test fun hiddenPeerAncestorBlocksRetirementUntilPeerIsActuallyVisible() = Fixture().use { f ->
    val peerParent = FrameLayout(f.context)
    f.root.removeView(f.incoming)
    f.root.addView(peerParent, FrameLayout.LayoutParams(100, 100))
    peerParent.addView(f.incoming, FrameLayout.LayoutParams(100, 100))
    peerParent.layout(0, 0, 100, 100); f.incoming.layout(0, 0, 100, 100)
    peerParent.alpha = 0f
    f.acquire(); f.draw()
    assertTrue(f.replies.isEmpty()); assertEquals(1f, f.outgoing.alpha)
    peerParent.alpha = 1f; f.draw()
    assertEquals(listOf<String?>(null), f.replies)
  }

  @Test fun visibleAncestorBlocksGrantDespitePeerAndJsIntent() = Fixture().use { f ->
    f.parent.alpha = 1f
    f.acquire(); f.draw()
    assertTrue(f.replies.isEmpty()); assertEquals(1f, f.outgoing.alpha)
    f.parent.alpha = 0f; f.draw()
    assertEquals(listOf<String?>(null), f.replies)
  }

  @Test fun cancellationBeforeQueuedGrantSettlesOnceAndCannotTouchAlpha() = Fixture().use { f ->
    f.owner.acquire(f.key, f.binding, f.peer, 1.0, 1.0, true) { f.replies.add(it) }
    f.owner.cancel(f.key, 1.0); f.drain(); f.draw()
    assertEquals(listOf("E_VIDEO_MASK_STALE"), f.replies)
    assertEquals(1f, f.outgoing.alpha); assertTrue(f.binding.observers.isEmpty())
  }

  @Test fun bindingFailureSettlesOnceAndRemovesRegisteredObservers() = Fixture().use { f ->
    val broken = object : VideoMaskLease.Binding by f.binding {
      override fun view(): View? = throw IllegalStateException("released binding")
    }
    f.owner.acquire(f.key, broken, f.peer, 1.0, 1.0, true) { f.replies.add(it) }
    f.drain(); f.draw()
    assertEquals(listOf("E_VIDEO_MASK_STALE"), f.replies)
    assertTrue(f.binding.observers.isEmpty()); assertTrue(f.binding.releases.isEmpty())
  }

  @Test fun cancelledGrantCannotAuthorizeRenewalOrRevealDirtyView() = Fixture().use { f ->
    f.acquire(); f.owner.cancel(f.key, 1.0); f.drain()
    f.parent.alpha = 1f
    f.acquire(2.0, 2.0); f.draw()
    assertEquals(1, f.replies.size) // Old granted state is not a new request grant.
    assertEquals(0f, f.outgoing.alpha) // Dirty cancellation never restores the mask.
    f.owner.prepared(f.key, 2.0)
    assertEquals(listOf("E_VIDEO_MASK_STALE"), f.commit(2.0, 2.0))
    f.parent.alpha = 0f; f.draw()
    assertEquals(2, f.replies.size)
    f.owner.prepared(f.key, 2.0)
    assertEquals(listOf("E_VIDEO_MASK_STALE"), f.commit(1.0, 1.0))
    assertEquals(listOf<String?>(null), f.commit(2.0, 2.0))
    assertEquals(1f, f.outgoing.alpha)
  }

  @Test fun renewalCannotNewlyMaskVisibleBindingBeforeItsOwnGrant() = Fixture().use { f ->
    f.acquire(); f.owner.cancel(f.key, 1.0); f.drain()
    val next = View(f.context)
    f.root.addView(next, FrameLayout.LayoutParams(100, 100))
    next.layout(0, 0, 100, 100)
    // Simulate discovering another actual binding at renewal, without lending it the
    // old grant. A real SDK target callback is separately exercised below.
    f.binding.node = next
    f.acquire(2.0, 2.0); f.draw()
    assertEquals(1, f.replies.size)
    assertEquals(1f, next.alpha)
    assertEquals(0f, f.outgoing.alpha)
  }

  @Test fun sdkRebindingKeepsDirtyMaskAndInvalidatesCheckpoint() = Fixture().use { f ->
    f.acquire(); f.owner.prepared(f.key, 1.0)
    val replacement = View(f.context)
    f.parent.addView(replacement, FrameLayout.LayoutParams(100, 100))
    replacement.layout(0, 0, 100, 100)
    f.binding.rebind(replacement)
    assertEquals(0f, replacement.alpha)
    assertEquals(listOf("E_VIDEO_MASK_STALE"), f.commit())
    f.owner.prepared(f.key, 1.0)
    assertEquals(listOf<String?>(null), f.commit())
    assertEquals(1f, replacement.alpha)
  }

  @Test fun sourceOrOutputChangeRejectsStaleRelease() = Fixture().use { f ->
    f.acquire(); f.owner.prepared(f.key, 1.0)
    f.binding.source = Any()
    assertEquals(listOf("E_VIDEO_MASK_STALE"), f.commit())
    f.owner.prepared(f.key, 1.0); f.binding.surface = Any()
    assertEquals(listOf("E_VIDEO_MASK_STALE"), f.commit())
    f.owner.prepared(f.key, 1.0); f.binding.frameState = Any()
    assertEquals(listOf("E_VIDEO_MASK_STALE"), f.commit())
    assertEquals(0f, f.outgoing.alpha)
  }

  @Test fun playerReleaseRemovesPermanentObserverAndPreservesDirtyExclusion() = Fixture().use { f ->
    f.acquire()
    val late = f.binding.observers.single()
    f.binding.releases.toList().forEach { it() }
    assertTrue(f.binding.observers.isEmpty()); assertTrue(f.binding.releases.isEmpty())
    late()
    assertEquals(0f, f.outgoing.alpha)
    assertEquals(listOf("E_VIDEO_MASK_STALE"), f.commit())
  }

  @Test fun backgroundAndTimeoutCleanPendingCallbacksWithoutUnmaskingDirtyLease() = Fixture().use { f ->
    f.acquire(); f.owner.suspend(); f.drain()
    f.owner.prepared(f.key, 1.0)
    assertEquals(listOf("E_VIDEO_MASK_STALE"), f.commit())
    f.owner.resume(); f.parent.alpha = 1f; f.acquire(2.0, 2.0)
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(5000))
    assertEquals(listOf(null, "E_VIDEO_MASK_TIMEOUT"), f.replies)
    assertEquals(0f, f.outgoing.alpha)
    f.owner.close(); f.drain()
    assertTrue(f.binding.observers.isEmpty())
  }
}
