package app.captionstudio.media

import android.content.Context
import android.graphics.Canvas
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

class CaptionPresentationView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val painter = TimelineTextPainter(context)
  private var caption: RenderCaption? = null
  private var geometry: Map<String, Any>? = null
  var currentMs = 0L
  var authored = false
  var editingPreview = false

  init { setWillNotDraw(false); clipChildren = false; clipToPadding = false }

  fun setCaption(value: Map<String, Any>) { caption = parseCaption(value); invalidate() }
  fun setGeometry(value: Map<String, Any>) {
    geometry = value
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val cue = caption ?: return
    if (width <= 0 || height <= 0) return
    val style = geometry?.let { value ->
      @Suppress("UNCHECKED_CAST") val position = value["position"] as Map<String, Number>
      @Suppress("UNCHECKED_CAST") val box = value["box"] as Map<String, Number>
      cue.style.copy(positionX = position.getValue("x").toFloat(), positionY = position.getValue("y").toFloat(),
        boxWidth = box.getValue("width").toFloat(), boxHeight = box.getValue("height").toFloat(),
        rotation = (value.getValue("rotation") as Number).toFloat(), scale = value.positiveScale("scale"),
        scaleX = value.positiveScale("scaleX"), scaleY = value.positiveScale("scaleY"))
    } ?: cue.style
    painter.drawPreview(canvas, cue.copy(style = style), currentMs, width, height, authored, editingPreview)
  }

  fun close() { painter.close() }
}
