package app.captionstudio.media

import android.graphics.Bitmap
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface

internal data class BitmapOrientation(
  val rotationDegrees: Int = 0,
  val flipHorizontal: Boolean = false,
) {
  companion object {
    val NORMAL = BitmapOrientation()

    fun fromExif(exif: ExifInterface) = BitmapOrientation(
      rotationDegrees = exif.rotationDegrees,
      flipHorizontal = exif.isFlipped,
    )
  }
}

internal fun orientBitmap(source: Bitmap, rotationDegrees: Int): Bitmap {
  return orientBitmap(source, normalizeRotationDegrees(rotationDegrees), false)
}

internal fun orientBitmap(source: Bitmap, orientation: BitmapOrientation): Bitmap {
  return orientBitmap(source, normalizeRotationDegrees(orientation.rotationDegrees), orientation.flipHorizontal)
}

private fun orientBitmap(source: Bitmap, normalizedRotation: Int, flipHorizontal: Boolean): Bitmap {
  if (normalizedRotation == 0 && !flipHorizontal) return source
  return Bitmap.createBitmap(
    source,
    0,
    0,
    source.width,
    source.height,
    Matrix().apply {
      if (flipHorizontal) setScale(-1f, 1f)
      if (normalizedRotation != 0) postRotate(normalizedRotation.toFloat())
    },
    true,
  )
}

internal fun orientBitmapAndRecycle(source: Bitmap, orientation: BitmapOrientation): Bitmap {
  return orientBitmapAndRecycle(
    source,
    normalizeRotationDegrees(orientation.rotationDegrees),
    orientation.flipHorizontal,
  )
}

internal fun orientBitmapAndRecycle(source: Bitmap, rotationDegrees: Int): Bitmap {
  return orientBitmapAndRecycle(source, normalizeRotationDegrees(rotationDegrees), false)
}

private fun orientBitmapAndRecycle(source: Bitmap, normalizedRotation: Int, flipHorizontal: Boolean): Bitmap {
  val oriented = try {
    orientBitmap(source, normalizedRotation, flipHorizontal)
  } catch (error: Throwable) {
    source.recycle()
    throw error
  }
  if (oriented !== source) source.recycle()
  return oriented
}

internal fun normalizeRotationDegrees(rotationDegrees: Int): Int {
  return ((rotationDegrees % 360) + 360) % 360
}

internal fun rotationSwapsDimensions(rotationDegrees: Int): Boolean {
  val normalized = normalizeRotationDegrees(rotationDegrees)
  return normalized == 90 || normalized == 270
}
