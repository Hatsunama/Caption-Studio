package app.captionstudio.media

import android.os.Build
import android.provider.MediaStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], manifest = Config.NONE)
class TimelineExportDeliveryTest {
  @Test
  fun rejectsShortVideoTrackEvenWhenContainerDurationMatchesRender() {
    // A non-empty MP4 can have a valid video track and dimensions while audio
    // extends the container to the requested four-second duration.
    val videoTrackDurationMs = 2_000L
    val containerDurationMs = 4_000L
    assertEquals(4_000L, maxOf(videoTrackDurationMs, containerDurationMs))

    assertThrows(IllegalStateException::class.java) {
      requireMatchingVideoTrackDuration(videoTrackDurationMs, expectedDurationMs = 4_000L, frameRate = 30)
    }
  }

  @Test
  fun acceptsVideoTrackWithinFrameToleranceButRejectsLargerMismatch() {
    assertEquals(3_967L, requireMatchingVideoTrackDuration(3_967L, expectedDurationMs = 4_000L, frameRate = 30))
    assertThrows(IllegalStateException::class.java) {
      requireMatchingVideoTrackDuration(3_900L, expectedDurationMs = 4_000L, frameRate = 30)
    }
    assertThrows(IllegalStateException::class.java) {
      requireMatchingVideoTrackDuration(0L, expectedDurationMs = 4_000L, frameRate = 30)
    }
  }

  @Test
  fun requireRenderedVideoFileRejectsMissingAndEmptyFiles() {
    val missing = File.createTempFile("caption-studio-missing", ".mp4")
    assertTrue(missing.delete())
    val empty = File.createTempFile("caption-studio-empty", ".mp4")
    empty.writeBytes(ByteArray(0))
    val rendered = File.createTempFile("caption-studio-rendered", ".mp4")
    rendered.writeBytes(ByteArray(48))

    val missingError = assertThrows(IllegalStateException::class.java) { requireRenderedVideoFile(missing) }
    assertTrue(missingError.message.orEmpty().contains("missing", ignoreCase = true))
    val emptyError = assertThrows(IllegalStateException::class.java) { requireRenderedVideoFile(empty) }
    assertTrue(emptyError.message.orEmpty().contains("empty", ignoreCase = true))
    assertEquals(48L, requireRenderedVideoFile(rendered))
  }

  @Test
  fun deliveredMediaMustMatchThePlannedShapeAndAudioIntent() {
    val withAudio = VerifiedRenderedVideo(
      sizeBytes = 12_345L,
      durationMs = 4_000L,
      width = 3_840,
      height = 2_160,
      hasAudioTrack = true,
    )
    assertEquals(withAudio, requireExpectedOutput(withAudio, 3_840, 2_160, audioExpected = true))
    assertThrows(IllegalStateException::class.java) {
      requireExpectedOutput(withAudio, 3_840, 3_840, audioExpected = true)
    }
    val withoutAudio = withAudio.copy(hasAudioTrack = false)
    assertThrows(IllegalStateException::class.java) {
      requireExpectedOutput(withoutAudio, 3_840, 2_160, audioExpected = true)
    }
    assertEquals(withoutAudio, requireExpectedOutput(withoutAudio, 3_840, 2_160, audioExpected = false))
  }

  @Test
  fun visibleDimensionsAccountForRotationAndEncodedCrop() {
    assertEquals(Pair(1_080, 1_920), visibleVideoDimensions(1_920, 1_080, rotationDegrees = 90))
    assertEquals(Pair(1_080, 1_920), visibleVideoDimensions(1_088, 1_920, cropLeft = 0, cropTop = 0, cropRight = 1_079, cropBottom = 1_919))
    assertEquals(Pair(1_080, 1_920), visibleVideoDimensions(1_920, 1_088, cropLeft = 0, cropTop = 0, cropRight = 1_919, cropBottom = 1_079, rotationDegrees = 270))
  }

  @Test
  fun visibleDimensionsRejectIncompleteOrInvalidMetadata() {
    assertThrows(IllegalStateException::class.java) {
      visibleVideoDimensions(1_088, 1_920, cropLeft = 0, cropTop = 0, cropRight = 1_079)
    }
    assertThrows(IllegalStateException::class.java) {
      visibleVideoDimensions(1_088, 1_920, cropLeft = 0, cropTop = 0, cropRight = 1_099, cropBottom = 1_919)
    }
    assertThrows(IllegalStateException::class.java) {
      visibleVideoDimensions(1_920, 1_080, rotationDegrees = 45)
    }
  }

  @Test
  fun finishedMediaStoreValuesMakeTheCopyVisibleAndPlayable() {
    val verified = VerifiedRenderedVideo(sizeBytes = 12_345L, durationMs = 4_000L, width = 720, height = 1_280)
    val pending = pendingVideoContentValues("caption-studio-export.mp4")
    val finished = finishedVideoContentValues(verified, nowMs = 1_700_000_000_000L)

    assertEquals("caption-studio-export.mp4", pending.getAsString(MediaStore.Video.Media.DISPLAY_NAME))
    assertEquals("video/mp4", pending.getAsString(MediaStore.Video.Media.MIME_TYPE))
    assertEquals("Movies/Caption Studio", pending.getAsString(MediaStore.Video.Media.RELATIVE_PATH))
    assertEquals(1, pending.getAsInteger(MediaStore.Video.Media.IS_PENDING))

    assertEquals(0, finished.getAsInteger(MediaStore.Video.Media.IS_PENDING))
    assertEquals(12_345L, finished.getAsLong(MediaStore.Video.Media.SIZE))
    assertEquals(4_000L, finished.getAsLong(MediaStore.Video.Media.DURATION))
    assertEquals(720, finished.getAsInteger(MediaStore.Video.Media.WIDTH))
    assertEquals(1_280, finished.getAsInteger(MediaStore.Video.Media.HEIGHT))
    assertEquals(1_700_000_000L, finished.getAsLong(MediaStore.Video.Media.DATE_ADDED))
    assertEquals(1_700_000_000L, finished.getAsLong(MediaStore.Video.Media.DATE_MODIFIED))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      assertEquals(1_700_000_000_000L, finished.getAsLong(MediaStore.Video.Media.DATE_TAKEN))
    }
  }
}
