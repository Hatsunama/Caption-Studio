package app.captionstudio.media

internal object TimelineTransitionSpec {
  enum class RenderingPath { NONE, COVER, COMPOSITE }

  // Every supported type declares its renderer; new types never inherit a fallback.
  private val renderingPaths = mapOf(
    "none" to RenderingPath.NONE,
    "dip-black" to RenderingPath.COVER,
    "dip-white" to RenderingPath.COVER,
    "flash" to RenderingPath.COVER,
    "fade-dark" to RenderingPath.COVER,
    "crossfade" to RenderingPath.COMPOSITE,
    "push-left" to RenderingPath.COMPOSITE,
    "push-right" to RenderingPath.COMPOSITE,
    "push-up" to RenderingPath.COMPOSITE,
    "push-down" to RenderingPath.COMPOSITE,
    "zoom-in" to RenderingPath.COMPOSITE,
    "zoom-out" to RenderingPath.COMPOSITE,
    "spin" to RenderingPath.COMPOSITE,
    "fold-horizontal" to RenderingPath.COMPOSITE,
    "fold-vertical" to RenderingPath.COMPOSITE,
    "iris-circle" to RenderingPath.COMPOSITE,
    "iris-diamond" to RenderingPath.COMPOSITE,
    "split-horizontal" to RenderingPath.COMPOSITE,
    "split-vertical" to RenderingPath.COMPOSITE,
    "shutter" to RenderingPath.COVER,
    "color-wash-cyan" to RenderingPath.COVER,
    "color-wash-magenta" to RenderingPath.COVER,
  )

  val supportedTypes = renderingPaths.keys
  val coverTypes = renderingPaths.filterValues { it == RenderingPath.COVER }.keys
  val compositeTypes = renderingPaths.filterValues { it == RenderingPath.COMPOSITE }.keys

  fun renderingPath(type: String): RenderingPath =
    requireNotNull(renderingPaths[type]) { "Unsupported video transition: $type" }

  fun requireSupported(type: String): String {
    renderingPath(type)
    return type
  }
}
