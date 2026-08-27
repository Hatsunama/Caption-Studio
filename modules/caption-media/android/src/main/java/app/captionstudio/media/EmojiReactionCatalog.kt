package app.captionstudio.media

import android.content.Context
import org.json.JSONObject
import java.text.Normalizer
import java.util.Locale

internal class EmojiReactionCatalog(context: Context) {
  private val categories: List<Category>
  private val categoriesById: Map<String, Category>

  init {
    val document = context.assets.open(ASSET_NAME).bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
    require(document.getInt("version") == 1) { "Unsupported emoji reaction catalog" }
    val fallback = document.getJSONArray("fallback").strings("fallback")
    require(fallback.size >= MINIMUM_REACTIONS) { "The emoji reaction fallback is incomplete" }
    require(fallback.distinct().size == fallback.size) { "The emoji reaction fallback contains duplicates" }
    categories = document.getJSONArray("categories").let { values ->
      (0 until values.length()).map { index ->
        val value = values.getJSONObject(index)
        Category(
          id = value.getString("id"),
          emojis = value.getJSONArray("emojis").strings("category emojis"),
          keywords = value.getJSONArray("keywords").strings("category keywords").map { rawKeyword ->
            val normalized = normalizeText(rawKeyword)
            Keyword(
              normalized = normalized,
              semanticKey = semanticKey(normalized),
              compact = COMPACT_SCRIPT.containsMatchIn(normalized),
            )
          },
        ).also { category ->
          require(category.id.isNotBlank()) { "An emoji reaction category has no identifier" }
          require(category.emojis.size >= MINIMUM_REACTIONS) { "Emoji reaction category ${category.id} is incomplete" }
          require(category.emojis.distinct().size == category.emojis.size) { "Emoji reaction category ${category.id} contains duplicates" }
          require(category.keywords.all { it.normalized.isNotBlank() }) { "Emoji reaction category ${category.id} has an empty keyword" }
        }
      }
    }
    require(categories.map(Category::id).distinct().size == categories.size) { "Emoji reaction category identifiers are duplicated" }
    require(categories.map { it.emojis.sorted() }.distinct().size == categories.size) { "Emoji reaction families are duplicated" }
    val keywordOwners = mutableMapOf<String, String>()
    categories.forEach { category ->
      category.keywords.forEach { keyword ->
        val previousOwner = keywordOwners.putIfAbsent(keyword.normalized, category.id)
        require(previousOwner == null || previousOwner == category.id) {
          "Emoji reaction keyword ${keyword.normalized} belongs to both $previousOwner and ${category.id}"
        }
      }
    }
    categoriesById = categories.associateBy(Category::id)
    require(REQUIRED_CATEGORY_IDS.all(categoriesById::containsKey)) { "The emoji reaction catalog is missing a required category" }
  }

  fun resolve(
    activeWord: String,
    captionText: String,
    contextWords: List<String> = listOf(activeWord),
    activeIndex: Int = 0,
  ): List<String> {
    val active = normalizeText(activeWord)
    if (NUMERIC_WORD.matches(active)) {
      val categoryId = if (active.firstOrNull() in CURRENCY_SYMBOLS) "money" else "number"
      return categoriesById.getValue(categoryId).emojis
    }
    findCategory(active, contextWords, activeIndex)?.let { return it.emojis }
    if (active.isBlank() && (captionText.contains('?') || captionText.contains('？'))) {
      return categoriesById.getValue("question").emojis
    }
    return emptyList()
  }

  private fun findCategory(text: String, contextWords: List<String>, activeIndex: Int): Category? {
    if (text.isBlank()) return null
    val tokens = LATIN_TOKEN.findAll(text).map(MatchResult::value).toList()
    if (semanticKey(text).isBlank() && tokens.isEmpty()) return null
    val contextKeys = semanticContextKeys(text, contextWords, activeIndex)
    var bestCategory: Category? = null
    var bestScore = 0

    categories.forEach { category ->
      category.keywords.forEach { keyword ->
        val score = if (keyword.compact) {
          if (keyword.semanticKey.isNotBlank() && keyword.semanticKey in contextKeys) {
            2_000 + keyword.semanticKey.codePointCount(0, keyword.semanticKey.length)
          } else {
            0
          }
        } else {
          val exact = keyword.normalized in tokens
          val inflected = !exact && tokens.any { token -> englishWordMatches(token, keyword.normalized) }
          if (exact || inflected) {
            (if (exact) 2_000 else 1_000) + keyword.normalized.codePointCount(0, keyword.normalized.length)
          } else {
            0
          }
        }
        if (score > bestScore) {
          bestCategory = category
          bestScore = score
        }
      }
    }

    return bestCategory
  }

  private fun semanticContextKeys(activeText: String, contextWords: List<String>, requestedIndex: Int): Set<String> {
    val hasUsableContext = requestedIndex in contextWords.indices
    val words = if (hasUsableContext) contextWords else listOf(activeText)
    val activeIndex = if (hasUsableContext) requestedIndex else 0
    val keys = linkedSetOf<String>()
    val firstIndex = maxOf(0, activeIndex - 5)
    val lastIndex = minOf(words.lastIndex, activeIndex + 5)

    for (start in firstIndex..activeIndex) {
      val phrase = StringBuilder()
      for (end in start..lastIndex) {
        if (end - start >= 6) break
        phrase.append(words[end])
        if (end >= activeIndex) {
          semanticKey(phrase.toString()).takeIf(String::isNotBlank)?.let(keys::add)
        }
      }
    }
    semanticKey(activeText).takeIf(String::isNotBlank)?.let(keys::add)
    return keys
  }

  private data class Category(
    val id: String,
    val emojis: List<String>,
    val keywords: List<Keyword>,
  )

  private data class Keyword(
    val normalized: String,
    val semanticKey: String,
    val compact: Boolean,
  )

  private companion object {
    const val ASSET_NAME = "emoji-reactions.json"
    const val MINIMUM_REACTIONS = 6
    val REQUIRED_CATEGORY_IDS = setOf("money", "number", "question")
    val CURRENCY_SYMBOLS = setOf('$', '€', '£', '¥')
    val NUMERIC_WORD = Regex("^[\\$€£¥]?\\d+(?:[.,]\\d+)?%?$")
    val LATIN_TOKEN = Regex("[\\p{L}\\p{N}'\\$€£¥]+")
    val COMPACT_SCRIPT = Regex("[\\p{IsHan}\\p{IsHiragana}\\p{IsKatakana}]")

    fun normalizeText(value: String): String = Normalizer.normalize(value, Normalizer.Form.NFKC)
      .lowercase(Locale.ROOT)
      .replace(Regex("[^\\p{L}\\p{N}'\\$€£¥?？.,%]+"), " ")
      .trim()

    fun semanticKey(value: String): String = normalizeText(value)
      .replace(Regex("[^\\p{L}\\p{N}\\$€£¥]+"), "")

    fun englishWordMatches(value: String, keyword: String) =
      englishWordForms(value).any(englishWordForms(keyword)::contains)

    fun englishWordForms(value: String): Set<String> {
      if (!Regex("^[a-z][a-z'-]{3,}$").matches(value)) return setOf(value)
      val forms = linkedSetOf(value)
      if (value.endsWith("ies") && value.length > 4) forms += value.dropLast(3) + "y"
      if (value.endsWith("ing") && value.length > 5) {
        var stem = value.dropLast(3)
        if (stem.length > 1 && stem.last() == stem[stem.lastIndex - 1]) stem = stem.dropLast(1)
        forms += stem
        forms += stem + "e"
      }
      if (value.endsWith("ed") && value.length > 4) {
        var stem = value.dropLast(2)
        if (stem.length > 1 && stem.last() == stem[stem.lastIndex - 1]) stem = stem.dropLast(1)
        forms += stem
        forms += stem + "e"
      }
      if (value.endsWith("es") && value.length > 4) forms += value.dropLast(2)
      if (value.endsWith("s") && value.length > 3) forms += value.dropLast(1)
      return forms
    }
  }
}

private fun org.json.JSONArray.strings(field: String): List<String> = (0 until length()).map { index ->
  getString(index).also { require(it.isNotBlank()) { "Emoji reaction $field contains an empty value" } }
}
