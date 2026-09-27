package app.captionstudio.media

import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class MediaInputPolicyTest {
  private val context get() = RuntimeEnvironment.getApplication()

  @Test
  fun acceptsAppOwnedCacheAndFiles() {
    val policy = MediaInputPolicy(context)
    listOf(context.cacheDir, context.filesDir, context.noBackupFilesDir).forEach { root ->
      val file = File(root, "media/source.mp4")
      assertEquals(file.canonicalPath, policy.requireInput(Uri.fromFile(file).toString()).path)
    }
  }

  @Test
  fun acceptsGrantedDocumentUriWithoutRewritingIt() {
    val uri = "content://example.documents/document/video%3A1"
    assertEquals(uri, MediaInputPolicy(context).requireInput(uri).toString())
  }

  @Test
  fun fontValidationRequiresAnAppOwnedFileBeforeOpeningIt() {
    val policy = MediaInputPolicy(context)
    val font = File(context.cacheDir, "fonts/imported.ttf")
    assertEquals(font.canonicalPath, policy.requireFontFile(Uri.fromFile(font).toString()).path)

    val documentError = assertThrows(IllegalArgumentException::class.java) {
      policy.requireFontFile("content://example.documents/document/font%3A1")
    }
    assertEquals("Copy the font into Caption Studio storage before validation", documentError.message)

    val outside = File(context.cacheDir.parentFile, "private.ttf")
    assertThrows(IllegalArgumentException::class.java) {
      policy.requireFontFile(Uri.fromFile(outside).toString())
    }
  }

  @Test
  fun rejectsOtherFilesAndPathTraversal() {
    val policy = MediaInputPolicy(context)
    val outside = File(context.cacheDir.parentFile, "private.mp4")
    assertThrows(IllegalArgumentException::class.java) {
      policy.requireInput(Uri.fromFile(outside).toString())
    }
    assertThrows(IllegalArgumentException::class.java) {
      policy.requireInput(Uri.fromFile(File(context.cacheDir, "../private.mp4")).toString())
    }
  }

  @Test
  fun rejectsNonDocumentSchemesBarePathsAndFileAuthorities() {
    val policy = MediaInputPolicy(context)
    listOf("https://example.com/video.mp4", "/data/local/tmp/video.mp4", "file://other-host/data/video.mp4").forEach { uri ->
      assertThrows(IllegalArgumentException::class.java) { policy.requireInput(uri) }
    }
  }
}
