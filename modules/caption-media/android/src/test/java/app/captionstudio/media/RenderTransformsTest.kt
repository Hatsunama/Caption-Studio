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

  @Test
  fun personScaleDoesNotMoveTheChosenPersonAnchor() {
    val common = PersonMatrixFixture(personScale = 1f).matrix()
    val enlarged = PersonMatrixFixture(personScale = 2.5f).matrix()
    val sourceCenter = floatArrayOf(50f, 25f)

    val commonCenter = mapped(common, sourceCenter)
    val enlargedCenter = mapped(enlarged, sourceCenter)

    assertArrayEquals(commonCenter, enlargedCenter, EPSILON)
    assertArrayEquals(floatArrayOf(140f, 110f), commonCenter, EPSILON)
  }

  @Test
  fun videoRotationRotatesPersonOffsetAroundVideoAnchor() {
    val matrix = PersonMatrixFixture(
      videoRotation = 90f,
      personPositionX = 0.7f,
      personPositionY = 0.6f,
    ).matrix()

    assertArrayEquals(
      floatArrayOf(90f, 140f),
      mapped(matrix, floatArrayOf(50f, 25f)),
      EPSILON,
    )
  }

  private fun assertMappedPoints(matrix: Matrix, points: FloatArray, expected: FloatArray) {
    assertArrayEquals(expected, mapped(matrix, points), EPSILON)
  }

  private fun mapped(matrix: Matrix, points: FloatArray) = points.copyOf().also(matrix::mapPoints)

  private data class PersonMatrixFixture(
    val videoRotation: Float = 0f,
    val personPositionX: Float = 0.7f,
    val personPositionY: Float = 0.6f,
    val personScale: Float = 1f,
  ) {
    fun matrix() = personContentMatrix(
      sourceWidth = 100,
      sourceHeight = 50,
      targetWidth = 200,
      targetHeight = 200,
      videoFit = "fit",
      videoPositionX = 0.5f,
      videoPositionY = 0.5f,
      videoScale = 1f,
      videoRotation = videoRotation,
      personPositionX = personPositionX,
      personPositionY = personPositionY,
      personScale = personScale,
      personRotation = 0f,
    )
  }

  private companion object {
    const val EPSILON = 0.001f
  }
}
