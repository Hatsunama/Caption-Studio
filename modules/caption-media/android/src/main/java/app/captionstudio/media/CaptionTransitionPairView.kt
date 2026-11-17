package app.captionstudio.media

import android.content.Context
import android.view.ViewGroup
import androidx.annotation.Keep

// Keep the Context constructor used reflectively by Expo, including in release builds.
@Keep
class CaptionTransitionPairView(context: Context) : ViewGroup(context) {
  private var foregroundSlot = 0

  init {
    setChildrenDrawingOrderEnabled(true)
  }

  fun setFrontSlot(slot: Int) {
    require(slot == 0 || slot == 1) { "frontSlot must be 0 or 1" }
    if (foregroundSlot == slot) return
    foregroundSlot = slot
    invalidate()
  }

  override fun getChildDrawingOrder(childCount: Int, drawingPosition: Int): Int =
    if (childCount == 2 && foregroundSlot == 0) 1 - drawingPosition else drawingPosition

  // Fabric/Yoga owns child measurement and positions independently of paint order.
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit
}
