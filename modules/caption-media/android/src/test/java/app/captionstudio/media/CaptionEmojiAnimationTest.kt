package app.captionstudio.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class CaptionEmojiAnimationTest {
  @Test
  fun cueProgressMatchesPreviewContract() {
    val resource = checkNotNull(javaClass.classLoader?.getResourceAsStream("caption-emoji-timing-contract.csv"))
    resource.bufferedReader().useLines { lines ->
      lines.drop(1).filter(String::isNotBlank).forEach { line ->
        val fields = line.split(',')
        val actual = captionCueProgress(fields[0].toLong(), fields[1].toLong(), fields[2].toLong())
        if (fields[3] == "hidden") assertNull(line, actual)
        else assertEquals(line, fields[3].toFloat(), checkNotNull(actual), 0.000001f)
      }
    }
  }

  @Test
  fun cueReactionsAreSparseAndRefreshFromEditedOrNewText() {
    val catalog = EmojiReactionCatalog(RuntimeEnvironment.getApplication())
    val camera = catalog.resolve("camera", "").take(2)
    assertEquals(2, camera.size)
    assertEquals(camera, captionCueEmojis(catalog, "the camera and money"))
    assertEquals(camera, captionCueEmojis(catalog, "camera camera camera"))
    assertEquals(camera, captionCueEmojis(catalog, "\u6253\u5f00\u76f8\u673a\u7684"))
    assertEquals(catalog.resolve("money", "").take(2), captionCueEmojis(catalog, "money"))
    assertEquals(emptyList<String>(), captionCueEmojis(catalog, "unknown filler"))
    assertEquals(emptyList<String>(), captionCueEmojis(catalog, ""))
  }
}
