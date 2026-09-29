package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream

class PublishedVideoSizeTest {
  @Test
  fun unknownDescriptorLengthRejectsTruncatedPublishedVideo() {
    assertThrows(IllegalStateException::class.java) {
      requirePublishedVideoSize(-1L, 8L) { ByteArrayInputStream(ByteArray(7)) }
    }
  }

  @Test
  fun unknownDescriptorLengthRequiresExactPublishedByteCount() {
    assertEquals(8L, requirePublishedVideoSize(-1L, 8L) { ByteArrayInputStream(ByteArray(8)) })
    assertThrows(IllegalStateException::class.java) {
      requirePublishedVideoSize(-1L, 8L) { ByteArrayInputStream(ByteArray(9)) }
    }
  }

  @Test
  fun knownDescriptorLengthMustMatchWithoutOpeningStream() {
    assertEquals(8L, requirePublishedVideoSize(8L, 8L) { error("stream should stay closed") })
    assertThrows(IllegalStateException::class.java) {
      requirePublishedVideoSize(7L, 8L) { error("stream should stay closed") }
    }
  }
}
