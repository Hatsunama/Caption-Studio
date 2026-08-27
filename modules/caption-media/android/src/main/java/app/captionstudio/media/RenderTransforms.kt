package app.captionstudio.media

import android.graphics.Matrix
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

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
): Matrix {
  val fitScale = if (fit == "fill") {
    max(targetWidth / sourceWidth.toFloat(), targetHeight / sourceHeight.toFloat())
  } else {
    min(targetWidth / sourceWidth.toFloat(), targetHeight / sourceHeight.toFloat())
  }
  return Matrix().apply {
    postTranslate(-sourceWidth / 2f, -sourceHeight / 2f)
    postScale(fitScale * scale, fitScale * scale)
    postRotate(rotation)
    postTranslate(positionX * targetWidth, positionY * targetHeight)
  }
}

internal fun personContentMatrix(
  sourceWidth: Int,
  sourceHeight: Int,
  targetWidth: Int,
  targetHeight: Int,
  videoFit: String,
  videoPositionX: Float,
  videoPositionY: Float,
  videoScale: Float,
  videoRotation: Float,
  personPositionX: Float,
  personPositionY: Float,
  personScale: Float,
  personRotation: Float,
): Matrix {
  val fitScale = if (videoFit == "fill") {
    max(targetWidth / sourceWidth.toFloat(), targetHeight / sourceHeight.toFloat())
  } else {
    min(targetWidth / sourceWidth.toFloat(), targetHeight / sourceHeight.toFloat())
  }
  val fittedVideoScale = fitScale * videoScale
  val offsetX = (personPositionX - 0.5f) * sourceWidth * fittedVideoScale
  val offsetY = (personPositionY - 0.5f) * sourceHeight * fittedVideoScale
  val radians = Math.toRadians(videoRotation.toDouble())
  val rotatedOffsetX = (offsetX * cos(radians) - offsetY * sin(radians)).toFloat()
  val rotatedOffsetY = (offsetX * sin(radians) + offsetY * cos(radians)).toFloat()
  return Matrix().apply {
    postTranslate(-sourceWidth / 2f, -sourceHeight / 2f)
    postScale(fittedVideoScale * personScale, fittedVideoScale * personScale)
    postRotate(videoRotation + personRotation)
    postTranslate(
      videoPositionX * targetWidth + rotatedOffsetX,
      videoPositionY * targetHeight + rotatedOffsetY,
    )
  }
}
