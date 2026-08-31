package app.captionstudio.media

internal object CaptionTextBreaks {
  private val tokenPattern = Regex("[\\p{IsHan}\\p{IsHiragana}\\p{IsKatakana}\\p{IsHangul}\\p{IsThai}]|[^\\s\\p{IsHan}\\p{IsHiragana}\\p{IsKatakana}\\p{IsHangul}\\p{IsThai}]+")
  private val compactPattern = Regex("^[\\p{IsHan}\\p{IsHiragana}\\p{IsKatakana}\\p{IsHangul}\\p{IsThai}\\p{P}\\p{S}]+$")
  private val closingPunctuation = Regex("^[,.;:!?%…、。！．：；？％)\\]\\}〉》」』】〕〗〙〛’”]+$")
  private val openingPunctuation = Regex("^[\\(\\[\\{〈《「『【〔〖〘〚‘“]+$")
  private val timingKeyCharacters = Regex("[\\p{L}\\p{N}\\p{M}']+")

  fun tokens(text: String): List<String> =
    tokenPattern.findAll(text.trim()).map { it.value }.filter(String::isNotBlank).toList()

  fun spokenTokens(text: String): List<String> {
    val result = mutableListOf<String>()
    tokens(text).forEach { token ->
      if (result.isNotEmpty() && closingPunctuation.matches(token)) {
        result[result.lastIndex] += token
      } else if (result.isNotEmpty() && openingPunctuation.matches(result.last())) {
        result[result.lastIndex] += token
      } else {
        result += token
      }
    }
    return result
  }

  fun timingUnits(text: String): List<CaptionTimingUnit> {
    val units = mutableListOf<CaptionTimingUnit>()
    var prefix = ""
    spokenTokens(text).forEach { token ->
      val key = timingKey(token)
      if (key.isEmpty()) {
        if (units.isNotEmpty()) units[units.lastIndex] = units.last().copy(text = units.last().text + token)
        else prefix += token
      } else {
        units += CaptionTimingUnit(prefix + token, key)
        prefix = ""
      }
    }
    if (prefix.isNotEmpty() && units.isNotEmpty()) {
      units[units.lastIndex] = units.last().copy(text = units.last().text + prefix)
    }
    return units
  }

  fun graphemeCount(text: String): Int {
    var count = 0
    var joinsNext = false
    text.codePoints().forEach { codePoint ->
      val type = Character.getType(codePoint)
      val combining = type == Character.NON_SPACING_MARK.toInt()
        || type == Character.COMBINING_SPACING_MARK.toInt()
        || type == Character.ENCLOSING_MARK.toInt()
        || codePoint in 0xFE00..0xFE0F
        || codePoint in 0x1F3FB..0x1F3FF
      val append = count > 0 && (joinsNext || codePoint == 0x200D || combining)
      if (!append) count += 1
      joinsNext = codePoint == 0x200D
    }
    return count
  }

  fun usesCompactSpacing(text: String): Boolean = compactPattern.matches(text)

  fun spreadTokens(text: String, startMs: Long, endMs: Long): List<SpreadTimedToken> {
    val tokens = spokenTokens(text).filter { it.isNotBlank() }
    if (tokens.isEmpty()) return emptyList()
    val rangeStart = maxOf(0L, startMs)
    val rangeEnd = maxOf(rangeStart + maxOf(10L, tokens.size * 10L), endMs)
    val durationMs = rangeEnd - rangeStart
    val weights = tokens.map { maxOf(1, graphemeCount(it)) }
    val totalWeight = weights.sum().coerceAtLeast(1)
    var consumed = 0
    return tokens.mapIndexed { index, token ->
      val tokenStart = if (index == 0) rangeStart else rangeStart + durationMs * consumed / totalWeight
      consumed += weights[index]
      val tokenEnd = if (index == tokens.lastIndex) rangeEnd else rangeStart + durationMs * consumed / totalWeight
      SpreadTimedToken(token, tokenStart, maxOf(tokenStart + 10, tokenEnd))
    }
  }

  private fun timingKey(text: String) = timingKeyCharacters
    .findAll(text.normalizeNfc().lowercase(java.util.Locale.ROOT).replace('’', '\''))
    .joinToString("") { it.value }
}

internal data class CaptionTimingUnit(val text: String, val key: String)

internal data class SpreadTimedToken(val text: String, val startMs: Long, val endMs: Long)

private fun String.normalizeNfc() = java.text.Normalizer.normalize(this, java.text.Normalizer.Form.NFC)
