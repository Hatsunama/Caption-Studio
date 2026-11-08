package app.captionstudio.media

import org.junit.Assert.*
import org.junit.Test

/** Actual observer with fake SDK boundary. These tests cannot prove native pixels. */
class PrivateVideoViewProbeTest {
  private class Fake : PrivateVideoViewProbe.Boundary {
    val queue = ArrayDeque<() -> Unit>()
    data class Pending(val at: Long, val action: () -> Unit, var cancelled: Boolean = false)
    val delayed = mutableListOf<Pending>()
    var clock = 0L
    var consumerValue = 0L
    var consumerReads = 0
    var snapshots = 0
    override fun postDelayed(delayMs: Long, action: () -> Unit): () -> Unit {
      check(main)
      val task = Pending(clock + delayMs, action)
      delayed += task
      return { check(main); task.cancelled = true }
    }
    fun advance(ms: Long) {
      val end = clock + ms
      while (true) {
        val next = delayed.filter { !it.cancelled && it.at <= end }.minByOrNull { it.at } ?: break
        delayed.remove(next)
        clock = next.at
        ui(next.action)
        drain()
      }
      clock = end
    }
    override fun consumerSnapshot(view: Any): LongArray {
      check(main)
      consumerReads++
      return longArrayOf(consumerValue)
    }
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
    override fun snapshot(view: Any): LongArray { check(main); snapshots++; return LongArray(21) { -1 } }
    override fun now() = clock
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
      assertEquals(if (fields[1] == "20") 31 else 30, fields.size)
      assertEquals("2", fields[0])
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

  @Test fun delayedReadsDescribeLaterConsumerAndCoalesceLayoutStormWithoutStarvation() {
    val f = Fake()
    val probe = PrivateVideoViewProbe(f)
    probe.start(); f.drain()
    val view = Any()
    f.ui { f.registered(view); repeat(100) { f.views.getValue(view)(3) } }
    assertEquals(3, f.delayed.count { !it.cancelled })
    assertEquals(0, f.consumerReads) // No native consumer read inline in layout dispatch.
    f.consumerValue = 41
    f.advance(0)
    assertEquals(41L, f.logs.last().split(',').last().toLong())
    f.consumerValue = 42
    f.advance(250)
    assertEquals(42L, f.logs.last().split(',').last().toLong())
    f.consumerValue = 43
    f.advance(750)
    val receipts = f.logs.map { it.split(',').map(String::toLong) }.filter { it[1] == 20L }
    assertEquals(listOf(0L, 250L, 1000L), receipts.map { it[4] })
    assertEquals(listOf(41L, 42L, 43L), receipts.map { it.last() })
    assertEquals(listOf(1L, 1L, 1L), receipts.map { it[7] }) // Original burst trigger.
    assertEquals(listOf(0L, 250L, 1000L), receipts.map { it[8] })
    f.advance(100000)
    assertEquals(3, f.consumerReads) // No self-rearming timer.
    f.ui { f.app(14) }
    f.advance(1000)
    assertEquals(6, f.consumerReads)
    assertTrue(f.logs.filter { it.split(',')[1] == "20" }.takeLast(3).all { it.split(',')[7] == "14" })
    probe.close(); f.drain()
  }

  @Test fun disposeCloseAndOffMainRejectDelayedWorkIncludingCopiedRunnables() {
    val f = Fake()
    val probe = PrivateVideoViewProbe(f)
    probe.start(); f.drain()
    val view = Any()
    f.ui { f.registered(view) }
    val copied = f.delayed.map { it.action }
    val count = f.snapshots
    copied.forEach { it() } // Deliberately off-main: cannot call any native getter.
    assertEquals(count, f.snapshots)
    f.ui { f.unregistered(view) }
    assertTrue(f.delayed.all { it.cancelled })
    f.ui { copied.forEach { it() } }
    assertEquals(0, f.consumerReads)
    f.ui { f.registered(view) }
    val again = f.delayed.filter { !it.cancelled }.map { it.action }
    probe.close() // Terminal flag must take effect before queued cleanup.
    f.ui { again.forEach { it() } }
    assertEquals(0, f.consumerReads)
    f.drain()
    assertTrue(f.delayed.all { it.cancelled })
  }

  @Test fun delayedSnapshotUsesCurrentBindingAndRespectsRowCapsWithoutNativeReads() {
    val f = Fake()
    val probe = PrivateVideoViewProbe(f)
    probe.start(); f.drain()
    val view = Any()
    val old = Any()
    val current = Any()
    f.ui { f.bindings[view] = old; f.registered(view) }
    f.ui { f.bindings[view] = current; f.views.getValue(view)(3) }
    f.advance(0)
    assertEquals(System.identityHashCode(current).toLong(), f.logs.last().split(',')[6].toLong())
    f.ui { repeat(150) { f.players.getValue(current)(5, 0, 0) } }
    val count = f.snapshots
    f.advance(1000)
    assertEquals(count, f.snapshots)
    assertEquals(120, f.logs.size)
    assertEquals(1, f.consumerReads)
    probe.close(); f.drain()
  }

  @Test fun schedulingIsBoundedAcrossRepeatedResumeAndRegistrationLifetimes() {
    val f = Fake()
    val probe = PrivateVideoViewProbe(f)
    probe.start(); f.drain()
    val view = Any()
    f.ui { f.registered(view) }
    repeat(40) { f.advance(1000); f.ui { f.app(14) } }
    f.advance(1000)
    assertEquals(72, f.consumerReads) // At most 24 bursts per live registration.
    f.ui { f.unregistered(view) }
    repeat(1400) {
      val other = Any()
      f.ui { f.registered(other); f.unregistered(other) }
    }
    assertTrue(f.delayed.size + f.consumerReads <= 4000)
    assertTrue(f.delayed.all { it.cancelled })
    assertTrue(f.logs.size <= 4000)
    probe.close(); f.drain()
  }

  @Test fun backgroundAndDetachCancelOldBurstsAndResumeAttachRearmFreshReads() {
    val f = Fake()
    val probe = PrivateVideoViewProbe(f)
    probe.start(); f.drain()
    val view = Any()
    f.ui { f.registered(view) }
    val stale = f.delayed.map { it.action }
    f.ui { f.app(15); f.app(14); stale.forEach { it() } }
    assertEquals(0, f.consumerReads) // Prior generation cannot impersonate the resume burst.
    f.advance(0)
    assertEquals(1, f.consumerReads)
    f.ui { f.views.getValue(view)(17) }
    f.advance(1000)
    assertEquals(1, f.consumerReads)
    f.ui { f.views.getValue(view)(2) }
    f.advance(1000)
    assertEquals(4, f.consumerReads)
    probe.close(); f.drain()
  }
}
