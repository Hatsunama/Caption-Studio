package app.captionstudio.media

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class EmojiReactionCatalogTest {
  private val catalog by lazy { EmojiReactionCatalog(RuntimeEnvironment.getApplication()) }

  @Test
  fun resolvesCurrentEnglishAndChineseMeaning() {
    assertEquals(listOf("💸", "🤑", "💰", "🪙", "💵", "💳"), catalog.resolve("money", ""))
    assertEquals(catalog.resolve("money", ""), catalog.resolve("钱", ""))
    assertEquals(catalog.resolve("camera", ""), catalog.resolve("recording", ""))
    assertEquals(catalog.resolve("love", ""), catalog.resolve("loved", ""))
    assertEquals(catalog.resolve("dance", ""), catalog.resolve("dancing", ""))
    assertEquals(catalog.resolve("happy", ""), catalog.resolve("开心", ""))
    assertEquals(catalog.resolve("car", ""), catalog.resolve("汽车", ""))
    assertNotEquals(catalog.resolve("money", ""), catalog.resolve("sad", ""))
  }

  @Test
  fun suppressesIrrelevantReactionsForFillerAndUnknownWords() {
    assertEquals(emptyList<String>(), catalog.resolve("the", "Turn on the camera"))
    assertEquals(emptyList<String>(), catalog.resolve("unknown-one", ""))
    assertEquals(emptyList<String>(), catalog.resolve("unknown-two", ""))
  }

  @Test
  fun activeSimplifiedAndTraditionalChineseGraphemesMatchTheSharedPreviewContract() {
    val resource = checkNotNull(javaClass.classLoader?.getResourceAsStream("emoji-reaction-context-contract.tsv"))
    resource.bufferedReader().useLines { lines ->
      lines.drop(1).filter(String::isNotBlank).forEach { line ->
        val fields = line.split('\t')
        val expected = fields[0]
        val caption = fields[1]
        val words = fields[2].split('␞')
        val activeIndex = fields[3].toInt()
        val actual = catalog.resolve(words[activeIndex], caption, words, activeIndex)
        val expectedEmojis = if (expected == "<empty>") emptyList() else catalog.resolve(expected, "")
        assertEquals("$caption active token ${words[activeIndex]}", expectedEmojis, actual)
      }
    }
  }

  @Test
  fun semanticReactionsAreDeterministicDiverseAndDoNotScanUnrelatedNearbyWords() {
    val words = listOf("打", "开", "相", "机", "的")
    val first = catalog.resolve(words[4], "打开相机的", words, 4)
    val second = catalog.resolve(words[4], "打开相机的", words, 4)
    assertEquals(emptyList<String>(), first)
    assertEquals(first, second)

    val families = listOf("money", "camera", "sad", "happy", "car", "shopping", "question", "technology")
      .map { catalog.resolve(it, "") }
    assertEquals(families.size, families.map(List<String>::joinToString).distinct().size)
    families.forEach { family -> assertEquals(6, family.distinct().size) }
  }

  @Test
  fun everyCatalogKeywordResolvesToItsDeclaredFamilyIncludingEachActiveCjkCharacter() {
    val context = RuntimeEnvironment.getApplication()
    val document = context.assets.open("emoji-reactions.json").bufferedReader(Charsets.UTF_8).use {
      JSONObject(it.readText())
    }
    val categories = document.getJSONArray("categories")
    for (categoryIndex in 0 until categories.length()) {
      val category = categories.getJSONObject(categoryIndex)
      val categoryId = category.getString("id")
      val expected = category.getJSONArray("emojis").let { emojis ->
        (0 until emojis.length()).map(emojis::getString)
      }
      val keywords = category.getJSONArray("keywords")
      for (keywordIndex in 0 until keywords.length()) {
        val keyword = keywords.getString(keywordIndex)
        if (Regex("\\p{IsHan}").containsMatchIn(keyword)) {
          val words = keyword.map(Char::toString)
          words.forEachIndexed { activeIndex, word ->
            assertEquals(
              "$categoryId: $keyword active token $word",
              expected,
              catalog.resolve(word, keyword, words, activeIndex),
            )
          }
        } else {
          assertEquals("$categoryId: $keyword", expected, catalog.resolve(keyword, ""))
        }
      }
    }
  }
}
