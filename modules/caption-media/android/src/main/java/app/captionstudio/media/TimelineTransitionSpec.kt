package app.captionstudio.media

internal object TimelineTransitionSpec {
  val supportedTypes = setOf(
    "none",
    "dip-black", "dip-white", "flash", "fade-dark", "crossfade",
    "push-left", "push-right", "push-up", "push-down",
    "zoom-in", "zoom-out", "spin",
    "fold-horizontal", "fold-vertical",
    "iris-circle", "iris-diamond",
    "split-horizontal", "split-vertical",
    "shutter", "glitch", "color-wash-cyan", "color-wash-magenta",
  )

  val coverTypes = setOf(
    "dip-black", "dip-white", "flash", "shutter",
    "color-wash-cyan", "color-wash-magenta",
  )

  val compositeTypes = supportedTypes - coverTypes - "none"

  fun requireSupported(type: String): String {
    require(type in supportedTypes) { "Unsupported video transition: $type" }
    return type
  }
}
