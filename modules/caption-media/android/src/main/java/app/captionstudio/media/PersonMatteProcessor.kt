package app.captionstudio.media

import android.graphics.Bitmap
import android.graphics.Rect
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

internal data class PersonMatteSettings(
  val preset: String,
  val threshold: Float,
  val softness: Float,
  val temporalStability: Float,
  val edgeFeather: Float,
)

internal class PersonMatteProcessor {
  private val faceDetector = FaceDetection.getClient(
    FaceDetectorOptions.Builder()
      .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
      .setMinFaceSize(0.08f)
      .enableTracking()
      .build(),
  )
  private var previousConfidence: FloatArray? = null
  private var previousAlpha: ByteArray? = null
  private var previousArea = 0f
  private var heldFrames = 0
  private var frameIndex = 0
  private var faceBounds = emptyList<Rect>()
  private var lastFaceSeenFrame = -1_000_000
  private var closed = false

  fun process(
    buffer: ByteBuffer,
    maskWidth: Int,
    maskHeight: Int,
    source: Bitmap,
    settings: PersonMatteSettings,
  ): ByteArray {
    check(!closed) { "The person matte processor has been released" }
    val safeSettings = settings.sanitized()
    val profile = MatteProfile.forName(safeSettings.preset)
    updateFaces(source, profile)
    buffer.order(ByteOrder.nativeOrder())
    buffer.rewind()
    val raw = FloatArray(maskWidth * maskHeight) { buffer.float.coerceIn(0f, 1f) }
    protectFaces(raw, maskWidth, maskHeight, source.width, source.height, profile.faceProtection)

    val currentArea = raw.count { it >= safeSettings.threshold }.toFloat() / raw.size.coerceAtLeast(1)
    val areaRatio = if (previousArea > 0.01f) currentArea / previousArea else 1f
    val implausible = previousAlpha != null && previousArea > 0.035f &&
      (areaRatio < profile.minimumAreaRatio || areaRatio > profile.maximumAreaRatio)
    if (implausible && heldFrames < profile.maximumHoldFrames) {
      heldFrames += 1
      return requireNotNull(previousAlpha).copyOf()
    }
    heldFrames = 0

    val stable = stabilize(raw, safeSettings.temporalStability, profile)
    val feathered = edgeAwareFeather(stable, maskWidth, maskHeight, safeSettings.edgeFeather)
    val alpha = confidenceToAlpha(feathered, safeSettings, profile)
    val cleaned = cleanupMask(alpha, maskWidth, maskHeight, profile.cleanupStrength)
    previousConfidence = stable.copyOf()
    previousAlpha = cleaned.copyOf()
    previousArea = currentArea
    return cleaned
  }

  fun reset() {
    previousConfidence = null
    previousAlpha = null
    previousArea = 0f
    heldFrames = 0
    frameIndex = 0
    faceBounds = emptyList()
    lastFaceSeenFrame = -1_000_000
  }

  fun close() {
    if (closed) return
    closed = true
    reset()
    faceDetector.close()
  }

  private fun updateFaces(source: Bitmap, profile: MatteProfile) {
    val currentFrame = frameIndex
    val shouldDetect = currentFrame % profile.faceInterval == 0
    frameIndex += 1
    if (!shouldDetect) {
      if (currentFrame - lastFaceSeenFrame > profile.faceHoldFrames) faceBounds = emptyList()
      return
    }
    runCatching {
      Tasks.await(faceDetector.process(InputImage.fromBitmap(source, 0)))
        .map { Rect(it.boundingBox) }
    }.onSuccess { detected ->
      if (detected.isNotEmpty()) {
        faceBounds = detected
        lastFaceSeenFrame = currentFrame
      } else if (currentFrame - lastFaceSeenFrame > profile.faceHoldFrames) {
        faceBounds = emptyList()
      }
    }.onFailure {
      if (currentFrame - lastFaceSeenFrame > profile.faceHoldFrames) faceBounds = emptyList()
    }
  }

  private fun protectFaces(
    confidence: FloatArray,
    maskWidth: Int,
    maskHeight: Int,
    sourceWidth: Int,
    sourceHeight: Int,
    protection: Float,
  ) {
    if (faceBounds.isEmpty() || protection <= 0f) return
    for (face in faceBounds) {
      val centerX = face.exactCenterX() / sourceWidth * maskWidth
      val centerY = face.exactCenterY() / sourceHeight * maskHeight
      val radiusX = max(2f, face.width() * 0.42f / sourceWidth * maskWidth)
      val radiusY = max(2f, face.height() * 0.52f / sourceHeight * maskHeight)
      val startX = max(0, (centerX - radiusX).toInt())
      val endX = minOf(maskWidth - 1, (centerX + radiusX).toInt())
      val startY = max(0, (centerY - radiusY).toInt())
      val endY = minOf(maskHeight - 1, (centerY + radiusY).toInt())
      val prior = previousConfidence?.takeIf { it.size == confidence.size }
      for (y in startY..endY) for (x in startX..endX) {
        val dx = (x - centerX) / radiusX
        val dy = (y - centerY) / radiusY
        val distance = dx * dx + dy * dy
        val index = y * maskWidth + x
        val centerWeight = (1f - distance).coerceIn(0f, 1f)
        val evidence = max(confidence[index], prior?.get(index) ?: 0f)
        if (distance <= 1f && evidence >= 0.24f) {
          confidence[index] = max(
            confidence[index],
            (evidence + protection * 0.1f * centerWeight).coerceAtMost(0.9f),
          )
        }
      }
    }
  }

  private fun stabilize(raw: FloatArray, configuredStability: Float, profile: MatteProfile): FloatArray {
    val prior = previousConfidence
    if (prior == null || prior.size != raw.size) return raw
    val base = max(configuredStability, profile.minimumStability).coerceIn(0f, 0.94f)
    return FloatArray(raw.size) { index ->
      val delta = abs(raw[index] - prior[index])
      val motionRelease = (delta / profile.motionThreshold).coerceIn(0f, 1f)
      val directionMultiplier = if (raw[index] >= prior[index]) 0.48f else 1f
      val historyWeight = (base * directionMultiplier * (1f - motionRelease * profile.motionResponsiveness))
        .coerceIn(0.06f, 0.94f)
      raw[index] * (1f - historyWeight) + prior[index] * historyWeight
    }
  }

  private fun edgeAwareFeather(values: FloatArray, width: Int, height: Int, configured: Float): FloatArray {
    val blend = configured.coerceIn(0f, 0.8f)
    if (blend <= 0f || width < 3 || height < 3) return values
    val output = values.copyOf()
    for (y in 1 until height - 1) for (x in 1 until width - 1) {
      val index = y * width + x
      if (values[index] in 0.08f..0.92f) {
        var weighted = values[index] * 4f
        var total = 4f
        for (dy in -1..1) for (dx in -1..1) {
          if (dx == 0 && dy == 0) continue
          val neighbor = values[(y + dy) * width + x + dx]
          val similarity = (1f - abs(neighbor - values[index]) * 2.5f).coerceIn(0.08f, 1f)
          weighted += neighbor * similarity
          total += similarity
        }
        output[index] = values[index] * (1f - blend) + (weighted / total) * blend
      }
    }
    return output
  }

  private fun confidenceToAlpha(values: FloatArray, settings: PersonMatteSettings, profile: MatteProfile): ByteArray {
    val prior = previousAlpha
    val softness = settings.softness.coerceIn(0.025f, 0.5f)
    return ByteArray(values.size) { index ->
      val wasForeground = prior != null && (prior[index].toInt() and 0xff) >= 128
      val cutoff = settings.threshold - if (wasForeground) profile.exitHysteresis else 0f
      val low = cutoff - softness / 2f
      val linear = ((values[index] - low) / softness).coerceIn(0f, 1f)
      val smooth = linear * linear * (3f - 2f * linear)
      (smooth * 255f).roundToInt().toByte()
    }
  }

  private fun cleanupMask(alpha: ByteArray, width: Int, height: Int, strength: Int): ByteArray {
    if (strength <= 0 || width < 3 || height < 3) return alpha
    var current = alpha
    repeat(strength) {
      val next = current.copyOf()
      for (y in 1 until height - 1) for (x in 1 until width - 1) {
        val index = y * width + x
        var foregroundNeighbors = 0
        var alphaSum = 0
        for (dy in -1..1) for (dx in -1..1) {
          if (dx == 0 && dy == 0) continue
          val neighbor = current[(y + dy) * width + x + dx].toInt() and 0xff
          if (neighbor >= 96) foregroundNeighbors += 1
          alphaSum += neighbor
        }
        val value = current[index].toInt() and 0xff
        if (value < 80 && foregroundNeighbors >= 6) next[index] = max(value, alphaSum / 8).toByte()
        if (value > 128 && foregroundNeighbors <= 1) next[index] = (alphaSum / 8).toByte()
      }
      current = next
    }
    return current
  }
}

private fun PersonMatteSettings.sanitized() = PersonMatteSettings(
  preset = when (preset) {
    "stable", "balanced", "detailed", "custom" -> preset
    else -> "stable"
  },
  threshold = threshold.takeIf(Float::isFinite)?.coerceIn(0f, 1f) ?: 0.46f,
  softness = softness.takeIf(Float::isFinite)?.coerceIn(0.001f, 1f) ?: 0.14f,
  temporalStability = temporalStability.takeIf(Float::isFinite)?.coerceIn(0f, 0.92f) ?: 0.78f,
  edgeFeather = edgeFeather.takeIf(Float::isFinite)?.coerceIn(0f, 1f) ?: 0.45f,
)

private data class MatteProfile(
  val minimumStability: Float,
  val exitHysteresis: Float,
  val motionThreshold: Float,
  val motionResponsiveness: Float,
  val minimumAreaRatio: Float,
  val maximumAreaRatio: Float,
  val maximumHoldFrames: Int,
  val cleanupStrength: Int,
  val faceProtection: Float,
  val faceInterval: Int,
  val faceHoldFrames: Int,
) {
  companion object {
    fun forName(name: String) = when (name) {
      "detailed" -> MatteProfile(0.42f, 0.05f, 0.14f, 0.9f, 0.38f, 2.7f, 1, 0, 0.55f, 4, 10)
      "balanced" -> MatteProfile(0.62f, 0.08f, 0.18f, 0.78f, 0.48f, 2.35f, 2, 1, 0.68f, 5, 15)
      "custom" -> MatteProfile(0.4f, 0.07f, 0.18f, 0.82f, 0.42f, 2.6f, 2, 1, 0.64f, 5, 15)
      else -> MatteProfile(0.78f, 0.1f, 0.22f, 0.66f, 0.56f, 2.05f, 3, 1, 0.75f, 6, 20)
    }
  }
}
