package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SfntFontValidatorTest {
  @Test
  fun acceptsBoundedTrueTypeTableDirectory() {
    val info = SfntFontValidator.validate(fontBytes())
    assertEquals("truetype", info.flavor)
    assertEquals(8, info.tableCount)
  }

  @Test
  fun rejectsMissingOutlineTables() {
    assertThrows(IllegalArgumentException::class.java) {
      SfntFontValidator.validate(fontBytes(listOf("cmap", "head", "hhea", "hmtx", "maxp", "name")))
    }
  }

  @Test
  fun rejectsTableRangesOutsideTheFile() {
    val bytes = fontBytes()
    putUInt32(bytes, 12 + 12, bytes.size.toLong() + 1L)
    assertThrows(IllegalArgumentException::class.java) { SfntFontValidator.validate(bytes) }
  }

  private fun fontBytes(
    tags: List<String> = listOf("cmap", "head", "hhea", "hmtx", "maxp", "name", "glyf", "loca"),
  ): ByteArray {
    val minimumLengths = mapOf(
      "cmap" to 4,
      "head" to 56,
      "hhea" to 36,
      "hmtx" to 4,
      "maxp" to 8,
      "name" to 8,
      "glyf" to 4,
      "loca" to 4,
    )
    val directoryEnd = 12 + tags.size * 16
    val bytes = ByteArray(directoryEnd + minimumLengths.values.sum() + 64)
    putUInt32(bytes, 0, 0x00010000L)
    putUInt16(bytes, 4, tags.size)
    var tableOffset = (directoryEnd + 3) and -4
    tags.forEachIndexed { index, tag ->
      val record = 12 + index * 16
      tag.toByteArray(Charsets.US_ASCII).copyInto(bytes, record)
      val length = requireNotNull(minimumLengths[tag])
      putUInt32(bytes, record + 8, tableOffset.toLong())
      putUInt32(bytes, record + 12, length.toLong())
      tableOffset = (tableOffset + length + 3) and -4
    }
    return bytes.copyOf(tableOffset)
  }

  private fun putUInt16(bytes: ByteArray, offset: Int, value: Int) {
    bytes[offset] = (value ushr 8).toByte()
    bytes[offset + 1] = value.toByte()
  }

  private fun putUInt32(bytes: ByteArray, offset: Int, value: Long) {
    bytes[offset] = (value ushr 24).toByte()
    bytes[offset + 1] = (value ushr 16).toByte()
    bytes[offset + 2] = (value ushr 8).toByte()
    bytes[offset + 3] = value.toByte()
  }
}
