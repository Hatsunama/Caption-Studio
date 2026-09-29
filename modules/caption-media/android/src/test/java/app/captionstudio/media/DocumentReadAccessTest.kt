package app.captionstudio.media

import android.content.ContentResolver
import android.content.UriPermission
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.FileNotFoundException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], manifest = Config.NONE)
class DocumentReadAccessTest {
  private val uri = Uri.parse("content://provider/video/1")

  @Test
  fun checkDoesNotAttemptToPersistAnUnretainedDocument() {
    val resolver = object : ContentResolver(RuntimeEnvironment.getApplication()) {
      override fun getPersistedUriPermissions(): List<UriPermission> = emptyList()

      override fun takePersistableUriPermission(uri: Uri, modeFlags: Int) {
        error("A read check must not take a persistable grant")
      }
    }

    assertEquals("missing", DocumentReadAccess(resolver).check(uri.toString())["status"])
  }

  @Test
  fun readableUnretainedDocumentNeedsPermissionWithoutChangingGrantState() {
    var opens = 0
    var retained = false
    val status = checkDocumentReadAccess(uri, { retained }) {
      opens++
    }
    assertEquals("permission-required", status["status"])
    assertEquals(1, opens)
    assertEquals(false, retained)
  }

  @Test
  fun explicitLegacyRecoveryCanMakeTheNextCheckReady() {
    var retained = false
    val probe = { checkDocumentReadAccess(uri, { retained }) { } }
    assertEquals("permission-required", probe()["status"])
    retained = true // Explicit persistReadPermission/retain action, outside the check.
    assertEquals("ready", probe()["status"])
  }

  @Test
  fun missingDocumentReportsMissingEvenWithRetainedGrant() {
    assertEquals("missing", checkDocumentReadAccess(uri, { true }) {
      throw FileNotFoundException("gone")
    }["status"])
  }
}
