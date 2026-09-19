package app.captionstudio.refract

import android.content.Context
import android.view.View
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

class CaptionRefractView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  val canvasView = RefractBackgroundView(context).also {
    it.isClickable = false
    it.isFocusable = false
    addView(it, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun setActive(active: Boolean) {
    canvasView.visibility = if (active) View.VISIBLE else View.INVISIBLE
  }
}
