package app.captionstudio.media

internal data class SfntFontInfo(val flavor: String, val tableCount: Int)

internal object SfntFontValidator {
  private val requiredTables = setOf("cmap", "head", "hhea", "hmtx", "maxp", "name")

  fun validate(bytes: ByteArray): SfntFontInfo {
    require(bytes.size >= 12) { "The selected font header is incomplete" }
    val flavor = when (uint32(bytes, 0)) {
      0x00010000L -> "truetype"
      0x4F54544FL -> "opentype-cff"
      0x74727565L -> "truetype-legacy"
      else -> throw IllegalArgumentException("Choose a standard TTF or OTF font file")
    }
    val tableCount = uint16(bytes, 4)
    require(tableCount in 1..128) { "The selected font has an invalid table directory" }
    val directoryEnd = 12L + tableCount.toLong() * 16L
    require(directoryEnd <= bytes.size) { "The selected font table directory is incomplete" }

    val tables = linkedMapOf<String, Pair<Long, Long>>()
    for (index in 0 until tableCount) {
      val recordOffset = 12 + index * 16
      val tag = ascii(bytes, recordOffset, 4)
      require(tag.all { it.code in 32..126 }) { "The selected font contains an invalid table name" }
      require(tag !in tables) { "The selected font contains duplicate $tag tables" }
      val offset = uint32(bytes, recordOffset + 8)
      val length = uint32(bytes, recordOffset + 12)
      require(offset % 4L == 0L) { "The selected font contains a misaligned $tag table" }
      require(length > 0L && offset >= directoryEnd && offset + length <= bytes.size.toLong()) {
        "The selected font contains an invalid $tag table"
      }
      tables[tag] = offset to length
    }

    require(tables.keys.containsAll(requiredTables)) { "The selected font is missing required typography tables" }
    val hasTrueTypeOutlines = tables.containsKey("glyf") && tables.containsKey("loca")
    val hasCffOutlines = tables.containsKey("CFF ") || tables.containsKey("CFF2")
    require(hasTrueTypeOutlines || hasCffOutlines) { "The selected font does not contain supported outlines" }
    require(requireNotNull(tables["cmap"]).second >= 4L) { "The selected font has an incomplete character map" }
    require(requireNotNull(tables["head"]).second >= 54L) { "The selected font has an incomplete header table" }
    require(requireNotNull(tables["hhea"]).second >= 36L) { "The selected font has an incomplete metrics header" }
    require(requireNotNull(tables["maxp"]).second >= 6L) { "The selected font has an incomplete glyph profile" }
    require(requireNotNull(tables["name"]).second >= 6L) { "The selected font has an incomplete naming table" }
    return SfntFontInfo(flavor, tableCount)
  }

  private fun uint16(bytes: ByteArray, offset: Int): Int {
    return ((bytes[offset].toInt() and 0xFF) shl 8) or (bytes[offset + 1].toInt() and 0xFF)
  }

  private fun uint32(bytes: ByteArray, offset: Int): Long {
    return ((bytes[offset].toLong() and 0xFF) shl 24) or
      ((bytes[offset + 1].toLong() and 0xFF) shl 16) or
      ((bytes[offset + 2].toLong() and 0xFF) shl 8) or
      (bytes[offset + 3].toLong() and 0xFF)
  }

  private fun ascii(bytes: ByteArray, offset: Int, length: Int): String {
    return String(bytes, offset, length, Charsets.US_ASCII)
  }
}
