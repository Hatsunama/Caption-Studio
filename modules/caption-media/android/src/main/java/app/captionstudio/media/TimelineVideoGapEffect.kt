package app.captionstudio.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import androidx.media3.common.GlObjectsProvider
import androidx.media3.common.GlTextureInfo
import androidx.media3.effect.GlEffect
import androidx.media3.effect.GlShaderProgram
import androidx.media3.effect.PassthroughShaderProgram

/** Timing-only image items must never enter the compositor's nearest-frame selection. */
internal class TimelineVideoGapEffect : GlEffect {
  override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
    object : PassthroughShaderProgram() {
      // Same consume/return protocol as Media3 1.10.1 SimpleFrameDroppingShaderProgram.
      // Inherited EOS/flush propagate even when this stream has produced zero textures.
      override fun queueInputFrame(provider: GlObjectsProvider, texture: GlTextureInfo, timeUs: Long) {
        try {
          getInputListener().onInputFrameProcessed(texture)
          getInputListener().onReadyToAcceptInputFrame()
        } catch (error: Exception) {
          onError(error)
        }
      }
    }
}

internal fun timelineVideoGapColor(backgroundColor: String, hasFootage: Boolean): Int {
  val color = Color.parseColor(backgroundColor)
  if (Color.alpha(color) == 255) return color
  val pixel = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
  try {
    val canvas = Canvas(pixel)
    pixel.eraseColor(Color.BLACK)
    canvas.drawColor(color)
    // 1.10.1 DefaultAssetLoaderFactory uses premultiplied BitmapFactory pixels;
    // GlUtil.setTexture uploads those bytes unchanged. The default SDR internal
    // sampler preserves RGB. DefaultCompositorGlProgram then uses SRC_ALPHA:
    // with footage, the base PNG's premultiplied RGB is multiplied by alpha again.
    // A base-only export has no compositor. Always return an OPAQUE cover so a
    // held footage frame cannot show through, including for "transparent".
    if (hasFootage) {
      val sampledRgb = pixel.getPixel(0, 0) and 0x00ffffff
      pixel.eraseColor(Color.BLACK)
      canvas.drawColor((color and -0x1000000) or sampledRgb)
    }
    return pixel.getPixel(0, 0)
  } finally {
    pixel.recycle()
  }
}
