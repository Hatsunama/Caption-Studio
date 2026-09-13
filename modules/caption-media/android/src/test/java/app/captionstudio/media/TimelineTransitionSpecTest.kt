package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TimelineTransitionSpecTest {
  @Test
  fun everyCatalogTypeHasAnExplicitExpectedRenderingPath() {
    val covers = setOf(
      "dip-black", "dip-white", "flash", "fade-dark", "shutter",
      "color-wash-cyan", "color-wash-magenta",
    )
    val composites = setOf(
      "crossfade", "push-left", "push-right", "push-up", "push-down",
      "zoom-in", "zoom-out", "spin", "fold-horizontal", "fold-vertical",
      "iris-circle", "iris-diamond", "split-horizontal", "split-vertical",
    )
    assertEquals(covers + composites + "none", TimelineTransitionSpec.supportedTypes)
    assertEquals(covers, TimelineTransitionSpec.coverTypes)
    assertEquals(composites, TimelineTransitionSpec.compositeTypes)
    assertEquals(TimelineTransitionSpec.RenderingPath.NONE, TimelineTransitionSpec.renderingPath("none"))
    covers.forEach { type ->
      assertEquals(type, TimelineTransitionSpec.RenderingPath.COVER, TimelineTransitionSpec.renderingPath(type))
    }
    composites.forEach { type ->
      assertEquals(type, TimelineTransitionSpec.RenderingPath.COMPOSITE, TimelineTransitionSpec.renderingPath(type))
    }
  }

  @Test
  fun dispatchRejectsUnknownAndUnregisteredLegacyTypes() {
    listOf("catalog-only-effect", "push-diagonal", "wipe-left", "slide-left", "").forEach { type ->
      val error = assertThrows(IllegalArgumentException::class.java) {
        TimelineTransitionSpec.renderingPath(type)
      }
      assertTrue(error.message.orEmpty().contains("Unsupported video transition"))
    }
  }

  @Test
  fun registryPartitionsEveryTransitionIntoOneNativeRenderingPath() {
    assertFalse("none" in TimelineTransitionSpec.compositeTypes)
    assertFalse("none" in TimelineTransitionSpec.coverTypes)
    assertTrue(TimelineTransitionSpec.compositeTypes.intersect(TimelineTransitionSpec.coverTypes).isEmpty())
    assertEquals(
      TimelineTransitionSpec.supportedTypes - "none",
      TimelineTransitionSpec.compositeTypes + TimelineTransitionSpec.coverTypes,
    )
  }

  @Test
  fun unknownTransitionsCannotReachTheNativeRenderer() {
    val error = assertThrows(IllegalArgumentException::class.java) {
      TimelineTransitionSpec.requireSupported("catalog-only-effect")
    }
    assertTrue(error.message.orEmpty().contains("Unsupported video transition"))
  }
}
