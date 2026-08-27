package app.captionstudio.media

import android.content.Context
import android.graphics.Bitmap
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.framework.image.ByteBufferExtractor
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.imagesegmenter.ImageSegmenter
import java.nio.ByteOrder

internal data class PersonConfidenceMask(
  val width: Int,
  val height: Int,
  val confidence: FloatArray,
)

internal class MediaPipePersonSegmenter(context: Context) : AutoCloseable {
  private val lifecycleLock = Any()
  private val segmenter = ImageSegmenter.createFromOptions(
    context,
    ImageSegmenter.ImageSegmenterOptions.builder()
      .setBaseOptions(
        BaseOptions.builder()
          .setModelAssetPath(MODEL_ASSET)
          .build(),
      )
      .setRunningMode(RunningMode.IMAGE)
      .setOutputCategoryMask(false)
      .setOutputConfidenceMasks(true)
      .build(),
  )
  private var closed = false

  fun segment(bitmap: Bitmap): PersonConfidenceMask = synchronized(lifecycleLock) {
    check(!closed) { "The person segmenter has been released" }
    val inputImage = BitmapImageBuilder(bitmap).build()
    try {
      val masks = segmenter.segment(inputImage).confidenceMasks()
        .orElseThrow { IllegalStateException("The person model did not return confidence masks") }
      try {
        require(masks.size >= PERSON_CLASS_COUNT) { "The person model returned an incompatible mask layout" }
        val background = masks[BACKGROUND_CLASS]
        val pixelCount = Math.multiplyExact(background.width, background.height)
        val buffer = ByteBufferExtractor.extract(background)
          .duplicate()
          .order(ByteOrder.nativeOrder())
        buffer.rewind()
        require(buffer.remaining() >= Math.multiplyExact(pixelCount, Float.SIZE_BYTES)) {
          "The person model returned an incomplete confidence mask"
        }
        val confidence = FloatArray(pixelCount) {
          (1f - buffer.float).coerceIn(0f, 1f)
        }
        PersonConfidenceMask(background.width, background.height, confidence)
      } finally {
        masks.forEach { mask -> runCatching { mask.close() } }
      }
    } finally {
      inputImage.close()
    }
  }

  override fun close() = synchronized(lifecycleLock) {
    if (closed) return@synchronized
    closed = true
    segmenter.close()
  }

  private companion object {
    const val MODEL_ASSET = "selfie_multiclass_256x256.tflite"
    const val BACKGROUND_CLASS = 0
    const val PERSON_CLASS_COUNT = 6
  }
}
