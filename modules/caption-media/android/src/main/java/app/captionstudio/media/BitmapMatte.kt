package app.captionstudio.media

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect

internal fun applyAlphaMask(
  source: Bitmap,
  alpha: ByteArray,
  maskWidth: Int,
  maskHeight: Int,
): Bitmap {
  require(alpha.size == maskWidth * maskHeight) { "The person mask dimensions are inconsistent" }
  val maskPixels = IntArray(alpha.size) { index ->
    ((alpha[index].toInt() and 0xff) shl 24) or 0x00ffffff
  }
  val alphaMask = Bitmap.createBitmap(maskPixels, maskWidth, maskHeight, Bitmap.Config.ARGB_8888)
  return try {
    val output = Bitmap.createBitmap(source.width, source.height, Bitmap.Config.ARGB_8888).apply {
      setHasAlpha(true)
      eraseColor(Color.TRANSPARENT)
    }
    try {
      val canvas = Canvas(output)
      canvas.drawBitmap(source, 0f, 0f, null)
      val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply {
        xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_IN)
      }
      canvas.drawBitmap(alphaMask, null, Rect(0, 0, output.width, output.height), paint)
      paint.xfermode = null
      output
    } catch (error: Throwable) {
      output.recycle()
      throw error
    }
  } finally {
    alphaMask.recycle()
  }
}
