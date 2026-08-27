package app.captionstudio.media

internal object TimelineTransitionSpec {
  val supportedTypes = setOf(
    "none",
    "dip-black", "dip-white", "flash", "fade-dark", "crossfade",
    "wipe-left", "wipe-right", "wipe-up", "wipe-down",
    "wipe-diagonal-tl", "wipe-diagonal-tr", "wipe-diagonal-bl", "wipe-diagonal-br",
    "slide-left", "slide-right", "slide-up", "slide-down",
    "push-left", "push-right", "push-up", "push-down",
    "zoom-in", "zoom-out", "spin",
    "fold-horizontal", "fold-vertical",
    "iris-circle", "iris-diamond",
    "split-horizontal", "split-vertical",
    "blinds-horizontal", "blinds-vertical",
    "checkerboard", "pixel-grid", "radial-clock", "stripes-diagonal", "slice-shuffle",
    "shutter", "glitch", "color-wash-cyan", "color-wash-magenta", "ripple-rings",
  )

  val coverTypes = setOf(
    "dip-black", "dip-white", "flash", "shutter",
    "color-wash-cyan", "color-wash-magenta", "ripple-rings",
  )

  val compositeTypes = supportedTypes - coverTypes - "none"

  fun requireSupported(type: String): String {
    require(type in supportedTypes) { "Unsupported video transition: $type" }
    return type
  }
}
