package app.captionstudio.media

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.View
import android.view.ViewGroup
import java.lang.reflect.InvocationTargetException
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Production ViewGroup drawing/layout contract on Robolectric native software Canvas.
 * No TextureView, RenderNode barrier, moving-frame, or device GPU claim.
 * Reflection keeps stage 1 compilable before the production class exists.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CaptionTransitionPairViewTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()

  private fun pair(): ViewGroup {
    val type = try {
      Class.forName("app.captionstudio.media.CaptionTransitionPairView")
    } catch (missing: ClassNotFoundException) {
      throw AssertionError("Production CaptionTransitionPairView must implement native sibling drawing order", missing)
    }
    assertEquals("standard ViewGroup owns drawing, RN owns layout", ViewGroup::class.java, type.superclass)
    return type.getConstructor(Context::class.java).newInstance(context) as ViewGroup
  }

  private fun front(pair: ViewGroup, slot: Int) {
    pair.javaClass.getMethod("setFrontSlot", Int::class.javaPrimitiveType!!).invoke(pair, slot)
  }

  private class Tile(context: Context, val slot: Int, color: Int, val draws: MutableList<Int>) : View(context) {
    private val paint = Paint().apply { this.color = color }
    var attaches = 0
    var detaches = 0
    var layouts = 0
    override fun onAttachedToWindow() { super.onAttachedToWindow(); attaches++ }
    override fun onDetachedFromWindow() { detaches++; super.onDetachedFromWindow() }
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) { layouts++ }
    override fun onDraw(canvas: Canvas) {
      draws.add(slot)
      canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
    }
  }

  private fun tile(slot: Int, draws: MutableList<Int>) =
    Tile(context, slot, if (slot == 0) Color.RED else Color.BLUE, draws).apply {
      measure(View.MeasureSpec.makeMeasureSpec(16, View.MeasureSpec.EXACTLY),
        View.MeasureSpec.makeMeasureSpec(16, View.MeasureSpec.EXACTLY))
      layout(0, 0, 16, 16) // Simulate Fabric/Yoga assigning child geometry.
    }

  private fun draw(pair: ViewGroup): Int {
    val bitmap = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888)
    try {
      pair.draw(Canvas(bitmap))
      return bitmap.getPixel(8, 8)
    } finally { bitmap.recycle() }
  }

  private fun pixel(expected: Int, actual: Int) {
    assertEquals(255, Color.alpha(actual))
    for (shift in listOf(0, 8, 16)) {
      val a = (actual shr shift) and 255
      val e = (expected shr shift) and 255
      assertTrue("expected RGB ${Integer.toHexString(expected)}, got ${Integer.toHexString(actual)}", kotlin.math.abs(a - e) <= 2)
    }
  }

  @Test fun drawsBothDirectionsAndBlendsFractionalFrontWithoutStructuralMutation() {
    val controller = Robolectric.buildActivity(Activity::class.java).setup()
    try {
      val pair = pair()
      val draws = mutableListOf<Int>()
      val children = listOf(tile(0, draws), tile(1, draws))
      children.forEach { pair.addView(it) }
      controller.get().setContentView(pair)
      pair.layout(0, 0, 16, 16)
      // Child bounds are externally owned even after attach/traversal.
      children.forEach { it.layout(0, 0, 16, 16) }
      var additions = 0
      var removals = 0
      pair.setOnHierarchyChangeListener(object : ViewGroup.OnHierarchyChangeListener {
        override fun onChildViewAdded(parent: View, child: View) { additions++ }
        override fun onChildViewRemoved(parent: View, child: View) { removals++ }
      })
      val lifecycle = children.map { Triple(it.attaches, it.detaches, it.layouts) }
      assertTrue("children really attached before swaps", children.all { it.attaches > 0 })
      assertTrue("pair keeps original clipping", pair.clipChildren)
      assertEquals(View.LAYER_TYPE_NONE, pair.layerType)
      for (slot in listOf(0, 1, 0, 1)) {
        front(pair, slot)
        front(pair, slot) // Repeated prop application must be harmless.
        assertFalse("front change must not request child layout", pair.isLayoutRequested)
        assertSame(children[0], pair.getChildAt(0))
        assertSame(children[1], pair.getChildAt(1))
        children.forEach { assertEquals(0f, it.elevation, 0f); assertEquals(0f, it.translationZ, 0f) }
        children.forEach { it.alpha = 1f }
        draws.clear()
        pixel(if (slot == 0) Color.RED else Color.BLUE, draw(pair))
        assertEquals(if (slot == 0) listOf(1, 0) else listOf(0, 1), draws)
        children[slot].alpha = 0.33974382f
        draws.clear()
        // Independent fixed source-over expectations: .33974382 * 255 = 86.635.
        pixel(if (slot == 0) Color.rgb(87, 0, 168) else Color.rgb(168, 0, 87), draw(pair))
        assertEquals(if (slot == 0) listOf(1, 0) else listOf(0, 1), draws)
      }
      assertEquals(0, additions)
      assertEquals(0, removals)
      assertEquals(lifecycle, children.map { Triple(it.attaches, it.detaches, it.layouts) })
    } finally { controller.pause().stop().destroy() }
  }

  @Test fun zeroOneTwoChildrenAndRemovalDoNotUseStaleDrawingIndices() {
    val pair = pair()
    val draws = mutableListOf<Int>()
    val a = tile(0, draws)
    val b = tile(1, draws)
    pair.layout(0, 0, 16, 16)
    for (slot in listOf(0, 1)) {
      front(pair, slot)
      draws.clear(); draw(pair); assertTrue(draws.isEmpty())
      pair.addView(a, 0)
      draws.clear(); pixel(Color.RED, draw(pair)); assertEquals(listOf(0), draws)
      pair.addView(b, 1)
      draws.clear(); pixel(if (slot == 0) Color.RED else Color.BLUE, draw(pair))
      assertEquals(if (slot == 0) listOf(1, 0) else listOf(0, 1), draws)
      pair.removeViewAt(0) // The remaining original slot 1 is now the only physical child.
      draws.clear(); pixel(Color.BLUE, draw(pair)); assertEquals(listOf(1), draws)
      pair.removeView(b)
      draws.clear(); draw(pair); assertTrue(draws.isEmpty())
      assertEquals(0, pair.childCount)
      assertNull(a.parent); assertNull(b.parent)
    }
  }

  @Test fun parentResizeLeavesExternallyMeasuredAndLaidOutChildrenUntouched() {
    val pair = pair()
    val child = tile(0, mutableListOf())
    pair.addView(child)
    child.layout(3, 5, 13, 15)
    val layouts = child.layouts
    for (slot in listOf(0, 1)) {
      front(pair, slot)
      pair.layout(0, 0, if (slot == 0) 300 else 200, if (slot == 0) 200 else 300)
      assertEquals(listOf(3, 5, 13, 15), listOf(child.left, child.top, child.right, child.bottom))
      assertEquals(listOf(16, 16), listOf(child.measuredWidth, child.measuredHeight))
      assertEquals(layouts, child.layouts)
    }
  }

  @Test fun invalidFrontSlotIsRejectedAndPreviousOrderSurvives() {
    val pair = pair()
    val draws = mutableListOf<Int>()
    pair.addView(tile(0, draws)); pair.addView(tile(1, draws))
    pair.layout(0, 0, 16, 16)
    front(pair, 0)
    for (invalid in listOf(-1, 2, Int.MAX_VALUE)) {
      try { front(pair, invalid); fail("frontSlot must reject $invalid") }
      catch (error: InvocationTargetException) { assertTrue(error.cause is IllegalArgumentException) }
      draws.clear(); pixel(Color.RED, draw(pair)); assertEquals(listOf(1, 0), draws)
    }
  }
}
