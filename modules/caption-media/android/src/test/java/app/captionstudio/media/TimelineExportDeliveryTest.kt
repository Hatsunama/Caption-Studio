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
