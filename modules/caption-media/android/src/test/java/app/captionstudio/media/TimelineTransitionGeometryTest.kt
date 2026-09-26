package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Test

class TimelineTransitionGeometryTest {
  @Test
  fun spinMatchesPreviewScaleAtStartMiddleAndEnd() {
    assertEquals(0.35f, spinTransitionScale(0f), 0.0001f)
    assertEquals(0.675f, spinTransitionScale(0.5f), 0.0001f)
    assertEquals(1f, spinTransitionScale(1f), 0.0001f)
  }

  @Test
  fun diamondUsesPreviewRotatedSquareOnRectangularCanvas() {
    assertEquals(0f, diamondIrisHalfDiagonal(8, 4, 0f), 0.0001f)
    assertEquals(3f, diamondIrisHalfDiagonal(8, 4, 0.5f), 0.0001f)
    assertEquals(6f, diamondIrisHalfDiagonal(8, 4, 1f), 0.0001f)
  }
}
