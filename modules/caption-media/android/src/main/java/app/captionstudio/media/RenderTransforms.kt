package app.captionstudio.media

import android.graphics.Matrix
import kotlin.math.max
import kotlin.math.min

internal fun contentMatrix(
  sourceWidth: Int,
  sourceHeight: Int,
  targetWidth: Int,
  targetHeight: Int,
  fit: String,
  positionX: Float,
  positionY: Float,
  scale: Float,
  rotation: Float,
  scaleX: Float = 1f,
  scaleY: Float = 1f,
): Matrix {
  val fitScale = if (fit == "fill") {
    max(targetWidth / sourceWidth.toFloat(), targetHeight / sourceHeight.toFloat())
  } else {
    min(targetWidth / sourceWidth.toFloat(), targetHeight / sourceHeight.toFloat())
  }
  return Matrix().apply {
    postTranslate(-sourceWidth / 2f, -sourceHeight / 2f)
    postScale(fitScale * scale * scaleX, fitScale * scale * scaleY)
    postRotate(rotation)
    postTranslate(positionX * targetWidth, positionY * targetHeight)
  }
}
