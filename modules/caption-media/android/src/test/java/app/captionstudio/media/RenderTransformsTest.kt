package app.captionstudio.media

import android.graphics.Matrix
import org.junit.Assert.assertArrayEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class RenderTransformsTest {
  @Test
  fun fitCentersEntireSourceWithoutCropping() {
    val matrix = contentMatrix(
      sourceWidth = 100,
      sourceHeight = 50,
      targetWidth = 200,
      targetHeight = 200,
      fit = "fit",
      positionX = 0.5f,
      positionY = 0.5f,
      scale = 1f,
      rotation = 0f,
    )

    assertMappedPoints(
      matrix,
      floatArrayOf(0f, 0f, 100f, 50f, 50f, 25f),
      floatArrayOf(0f, 50f, 200f, 150f, 100f, 100f),
    )
  }

  @Test
  fun fillCropsOverflowWhileCoveringTarget() {
    val matrix = contentMatrix(
      sourceWidth = 100,
      sourceHeight = 50,
      targetWidth = 200,
      targetHeight = 200,
      fit = "fill",
      positionX = 0.5f,
      positionY = 0.5f,
      scale = 1f,
      rotation = 0f,
    )

    assertMappedPoints(
      matrix,
      floatArrayOf(0f, 0f, 100f, 50f, 50f, 25f),
      floatArrayOf(-100f, 0f, 300f, 200f, 100f, 100f),
    )
  }

  @Test
  fun contentRotationAndPositionUseTheRequestedCanvasAnchor() {
    val matrix = contentMatrix(
      sourceWidth = 100,
      sourceHeight = 50,
      targetWidth = 200,
      targetHeight = 100,
      fit = "fit",
      positionX = 0.25f,
      positionY = 0.75f,
      scale = 1f,
      rotation = 90f,
    )

    assertMappedPoints(
      matrix,
      floatArrayOf(50f, 25f, 100f, 25f),
      floatArrayOf(50f, 75f, 50f, 175f),
    )
  }

  private fun assertMappedPoints(matrix: Matrix, points: FloatArray, expected: FloatArray) {
    assertArrayEquals(expected, mapped(matrix, points), EPSILON)
  }

  private fun mapped(matrix: Matrix, points: FloatArray) = points.copyOf().also(matrix::mapPoints)

  private companion object {
    const val EPSILON = 0.001f
  }
}
