package app.captionstudio.media

import android.graphics.Point
import android.graphics.Rect
import android.graphics.SurfaceTexture
import android.view.TextureView
import android.view.View
import android.widget.FrameLayout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Exercises the actual getter helper, not a reimplementation of the payload.
 * Synthetic TextureView/SurfaceTexture getters below test reads/errors only, never native pixels.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrivateVideoViewConsumerSnapshotTest {
  private val context get() = RuntimeEnvironment.getApplication()
  private fun read(view: View?) = PrivateVideoViewProbe.SDKSnapshot.consumer(view)

  @Test fun nullAndNonTextureAreExplicitlyUnknownRatherThanUnavailable() {
    assertArrayEquals(longArrayOf(0, -1, 0, -1, 0, 0, 0), read(null))
    val result = read(View(context))
    assertEquals(3L, result[0])
    assertEquals(-1L, result[1])
    assertEquals(-1L, result[3])
    assertEquals(1L, result[5])
    assertEquals(37, result.size)
  }

  @Test fun actualTextureViewUnavailableDoesNotInstallOrReplaceSurfaceListener() {
    val view = TextureView(context)
    val before = view.surfaceTextureListener
    val result = read(view)
    assertEquals(1L, result[0])
    assertEquals(0L, result[1])
    assertEquals(0L, result[2])
    assertEquals(-1L, result[3])
    assertEquals(0L, result[4])
    assertSame(before, view.surfaceTextureListener)
  }

  @Test fun currentTimestampAndIdentityAreReadAgainAndGetterFailureIsNumeric() {
    var stamp = 17L
    var fail = false
    val texture = object : SurfaceTexture(0) {
      override fun getTimestamp(): Long {
        if (fail) throw IllegalStateException("private URI must not escape")
        return stamp
      }
    }
    val view = object : TextureView(context) {
      override fun isAvailable() = true
      override fun getSurfaceTexture() = texture
    }
    try {
      val first = read(view)
      assertEquals(1L, first[1])
      assertEquals(System.identityHashCode(texture).toLong(), first[2])
      assertEquals(17L, first[3])
      stamp = 23
      assertEquals(23L, read(view)[3])
      fail = true
      val failed = read(view)
      assertEquals(1L, failed[1])
      assertEquals(System.identityHashCode(texture).toLong(), failed[2])
      assertEquals(-1L, failed[3])
      assertEquals(1L, failed[4])
      assertTrue(failed.joinToString(",").split(',').all { it.toLongOrNull() != null })
    } finally { texture.release() }
  }

  @Test fun readsActualAncestorAlphaClipGeometryAndSiblingIndexWithoutMutation() {
    val root = FrameLayout(context)
    val child = TextureView(context)
    root.addView(View(context))
    root.addView(child)
    root.layout(0, 0, 400, 300)
    child.layout(10, 20, 210, 120)
    root.alpha = 0.25f
    root.clipChildren = false
    root.clipToPadding = false
    child.clipBounds = Rect(1, 2, 30, 40)
    child.translationZ = 7f
    val before = child.clipBounds
    val result = read(child)
    assertEquals(2L, result[5])
    assertEquals(0L, result[6])
    val n = 7
    assertEquals(200L, result[n + 6])
    assertEquals(100L, result[n + 7])
    assertEquals(7f.toRawBits().toLong(), result[n + 9])
    assertEquals(1L, result[n + 17])
    assertEquals(listOf(1L, 2L, 30L, 40L), result.slice(n + 18..n + 21))
    assertEquals(1L, result[n + 24])
    assertEquals(2L, result[n + 25])
    assertEquals(10L, result[n + 26])
    assertEquals(20L, result[n + 27])
    assertEquals(0.25f.toRawBits().toLong(), result[n + 30 + 8])
    assertEquals(0L, result[n + 30 + 22])
    assertEquals(0L, result[n + 30 + 23])
    assertEquals(before, child.clipBounds)
    assertEquals(0.25f, root.alpha, 0f)
    assertSame(root, child.parent)
  }

  @Test fun visibleRectGetterResultIsEncodedAndTraversalStopsAtEightNodes() {
    val leaf = object : View(context) {
      override fun getGlobalVisibleRect(rect: Rect, offset: Point?): Boolean {
        rect.set(4, 5, 14, 15)
        return true
      }
    }
    var node: View = leaf
    repeat(20) { val parent = FrameLayout(context); parent.addView(node); node = parent }
    val result = read(leaf)
    assertEquals(8L, result[5])
    assertEquals(1L, result[6])
    assertEquals(7 + 8 * 30, result.size)
    assertEquals(1L, result[7 + 12])
    assertEquals(listOf(4L, 5L, 14L, 15L), result.slice(7 + 13..7 + 16))
  }

  @Test fun detectsTextureRecreationEvenWhenViewIdentityAndAvailabilityStayTheSame() {
    val old = SurfaceTexture(0)
    val next = SurfaceTexture(0)
    var current: SurfaceTexture? = old
    val view = object : TextureView(context) {
      override fun isAvailable() = true
      override fun getSurfaceTexture() = current
    }
    try {
      val first = read(view)
      current = next
      val second = read(view)
      assertEquals(first[7], second[7]) // Surface View identity unchanged.
      assertEquals(1L, first[1])
      assertEquals(1L, second[1])
      assertEquals(System.identityHashCode(old).toLong(), first[2])
      assertEquals(System.identityHashCode(next).toLong(), second[2])
      current = null
      assertEquals(0L, read(view)[2])
      assertEquals(-1L, read(view)[3])
    } finally { old.release(); next.release() }
  }
}
