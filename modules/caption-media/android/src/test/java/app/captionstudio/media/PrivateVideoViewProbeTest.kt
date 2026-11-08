package app.captionstudio.media

import org.junit.Assert.*
import org.junit.Test

/** Actual observer with fake SDK boundary. These tests cannot prove native pixels. */
class PrivateVideoViewProbeTest {
  private class Fake : PrivateVideoViewProbe.Boundary {
    val queue = ArrayDeque<() -> Unit>()
    val logs = mutableListOf<String>()
    val bindings = mutableMapOf<Any, Any?>()
    val views = mutableMapOf<Any, (Int) -> Unit>()
    val players = mutableMapOf<Any, (Int, Int, Int) -> Unit>()
    val removed = mutableListOf<Any>()
    var registered: (Any) -> Unit = {}
    var unregistered: (Any) -> Unit = {}
    var app: (Int) -> Unit = {}
    var managerAdds = 0
    var managerRemoves = 0
    var main = false
    override fun isMain() = main
    override fun post(action: () -> Unit) { queue.addLast(action) }
    fun ui(action: () -> Unit) {
      val previous = main
      main = true
      try { action() } finally { main = previous }
    }
    fun drain() { while (queue.isNotEmpty()) ui(queue.removeFirst()) }
    override fun manager(registered: (Any) -> Unit, unregistered: (Any) -> Unit, app: (Int) -> Unit): () -> Unit {
      check(main)
      managerAdds++
      this.registered = registered
      this.unregistered = unregistered
      this.app = app
      return { check(main); managerRemoves++ }
    }
    override fun view(view: Any, event: (Int) -> Unit): () -> Unit {
      check(main)
      views[view] = event
      return { check(main); assertNotNull(views.remove(view)) }
    }
    override fun binding(view: Any): Any? { check(main); return bindings[view] }
    override fun player(player: Any, event: (Int, Int, Int) -> Unit): () -> Unit {
      check(main)
      players[player] = event
      return { check(main); assertNotNull(players.remove(player)); removed += player }
    }
    override fun snapshot(view: Any): LongArray { check(main); return LongArray(21) { -1 } }
    override fun now() = 123L
    override fun log(csv: String) { check(main); logs += csv }
  }

  @Test fun closedBeforeQueuedStartCannotResurrectAndCloseIsIdempotent() {
    val f = Fake()
    val probe = PrivateVideoViewProbe(f)
    probe.start()
    probe.close()
    probe.close()
    probe.start()
    f.drain()
    assertEquals(0, f.managerAdds)
    assertEquals(0, f.managerRemoves)
    assertTrue(f.logs.isEmpty())
  }

  @Test fun ownsOnlyItsListenersAndRebindRejectsOldCallbacks() {
    val f = Fake()
    val probe = PrivateVideoViewProbe(f)
    probe.start(); probe.start(); f.drain()
    assertEquals(1, f.managerAdds)
    val view = Any()
    val first = Any()
    val second = Any()
    f.ui {
      f.registered(view) // Constructor callback, no player yet.
      assertTrue(f.players.isEmpty())
      f.bindings[view] = first
      f.views.getValue(view)(2) // Attach discovers props binding before layout.
      assertTrue(f.players.containsKey(first))
    }
    val stale = f.players.getValue(first)
    f.ui {
      f.bindings[view] = second
      stale(12, 0, 0)
      assertTrue(f.removed.isEmpty()) // No SDK list mutation during dispatch.
    }
    f.drain()
    assertEquals(listOf(first), f.removed)
    assertTrue(f.players.containsKey(second))
    val count = f.logs.size
    f.ui { stale(7, 0, 0) }
    assertEquals(count, f.logs.size)
    f.ui { f.unregistered(view); f.unregistered(view) }
    assertEquals(listOf(first, second), f.removed)
    assertTrue(f.views.isEmpty())
    probe.close(); probe.close(); f.drain()
    assertEquals(1, f.managerRemoves)
  }

  @Test fun capsDropRowsWithoutInlineCleanupAndCsvIsNumeric() {
    val f = Fake()
    val probe = PrivateVideoViewProbe(f)
    probe.start(); f.drain()
    val view = object { override fun toString() = "content://private/filename caption error.message" }
    val player = Any()
    f.ui {
      f.bindings[view] = player
      f.registered(view)
      repeat(150) { f.players.getValue(player)(5, Int.MIN_VALUE, Int.MAX_VALUE) }
      assertEquals(120, f.logs.size)
      assertTrue(f.removed.isEmpty())
      // Per-view limits reset for another view; the module-wide limit does not.
      repeat(40) {
        val other = Any()
        f.registered(other)
        repeat(125) { f.views.getValue(other)(3) }
        f.unregistered(other)
      }
      assertEquals(4000, f.logs.size)
    }
    f.logs.forEach { row ->
      val fields = row.split(',')
      assertEquals(30, fields.size)
      fields.forEach { assertNotNull(it.toLongOrNull()) }
    }
    // Off-main callbacks cannot read native snapshots or mutate listeners.
    val count = f.logs.size
    f.players.getValue(player)(5, 0, 0)
    assertEquals(count, f.logs.size)
    probe.close()
    f.drain()
    assertEquals(listOf(player), f.removed)
    assertTrue(f.views.isEmpty())
    assertTrue(f.players.isEmpty())
    assertEquals(1, f.managerRemoves)
  }

  @Test fun closeInvalidatesQueuedRebindAndCallbacksBeforeCleanupRuns() {
    val f = Fake()
    val probe = PrivateVideoViewProbe(f)
    probe.start(); f.drain()
    val view = Any()
    val player = Any()
    f.ui { f.bindings[view] = player; f.registered(view) }
    val callback = f.players.getValue(player)
    f.ui { f.bindings[view] = Any(); callback(12, 0, 0) }
    probe.close()
    val count = f.logs.size
    f.ui { callback(7, 0, 0); f.registered(Any()) }
    assertEquals(count, f.logs.size)
    f.drain()
    assertEquals(listOf(player), f.removed)
    assertTrue(f.players.isEmpty())
    assertTrue(f.views.isEmpty())
  }
}
