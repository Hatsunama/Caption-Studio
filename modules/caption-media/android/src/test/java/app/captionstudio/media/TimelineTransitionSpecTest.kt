package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TimelineTransitionSpecTest {
  @Test
  fun registryPartitionsEveryTransitionIntoOneNativeRenderingPath() {
    assertTrue(TimelineTransitionSpec.supportedTypes.size - 1 >= 28)
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
