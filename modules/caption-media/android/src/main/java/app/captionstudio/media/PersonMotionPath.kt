package app.captionstudio.media

import kotlin.math.max

internal data class PersonTransform(
  val positionX: Float,
  val positionY: Float,
  val scale: Float,
  val rotation: Float,
)

internal data class PersonTransformFrame(
  val timeMs: Long,
  val transform: PersonTransform,
)

internal class PersonMotionPath(
  fallback: PersonTransform,
  frames: List<PersonTransformFrame>,
) {
  private val fallback = sanitize(fallback)
  private val frames = frames
    .map { PersonTransformFrame(max(0L, it.timeMs), sanitize(it.transform)) }
    .sortedBy { it.timeMs }

  fun resolve(timeMs: Long): PersonTransform {
    if (frames.isEmpty()) return fallback
    if (timeMs <= frames.first().timeMs) return frames.first().transform
    if (timeMs >= frames.last().timeMs) return frames.last().transform
    val rightIndex = frames.indexOfFirst { it.timeMs >= timeMs }
    val left = frames[rightIndex - 1]
    val right = frames[rightIndex]
    val linear = (timeMs - left.timeMs).toFloat() / max(1L, right.timeMs - left.timeMs)
    val eased = linear * linear * (3f - 2f * linear)
    return PersonTransform(
      positionX = interpolate(left.transform.positionX, right.transform.positionX, eased),
      positionY = interpolate(left.transform.positionY, right.transform.positionY, eased),
      scale = interpolate(left.transform.scale, right.transform.scale, eased),
      rotation = normalizeAngle(left.transform.rotation + shortestAngle(left.transform.rotation, right.transform.rotation) * eased),
    )
  }

  private fun sanitize(value: PersonTransform) = PersonTransform(
    value.positionX.takeIf(Float::isFinite)?.coerceIn(-1f, 2f) ?: 0.5f,
    value.positionY.takeIf(Float::isFinite)?.coerceIn(-1f, 2f) ?: 0.5f,
    value.scale.takeIf(Float::isFinite)?.coerceIn(0.05f, 8f) ?: 1f,
    normalizeAngle(value.rotation.takeIf(Float::isFinite) ?: 0f),
  )

  private fun interpolate(left: Float, right: Float, progress: Float) = left + (right - left) * progress

  private fun shortestAngle(left: Float, right: Float) = ((right - left + 540f) % 360f) - 180f

  private fun normalizeAngle(value: Float) = ((value + 180f) % 360f + 360f) % 360f - 180f
}
