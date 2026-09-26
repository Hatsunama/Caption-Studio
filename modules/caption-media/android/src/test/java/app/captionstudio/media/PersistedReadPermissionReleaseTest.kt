package app.captionstudio.media

import android.net.Uri
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], manifest = Config.NONE)
class PersistedReadPermissionReleaseTest {
  private val uri = Uri.parse("content://provider/video/1")

  @Test
  fun absentGrantIsAlreadySettled() {
    var releases = 0
    assertTrue(releasePersistedReadPermission(uri, { false }) { releases += 1 })
    assertTrue(releasePersistedReadPermission(uri, { false }) { releases += 1 })
    assertTrue(releases == 0)
  }

  @Test
  fun successfulReleaseRequiresGrantToBeAbsentAfterward() {
    var retained = true
    assertTrue(releasePersistedReadPermission(uri, { retained }) { retained = false })
    assertFalse(retained)
    assertFalse(releasePersistedReadPermission(uri, { true }) { })
  }

  @Test
  fun securityFailureKeepsStillPresentGrantPending() {
    assertFalse(releasePersistedReadPermission(uri, { true }) {
      throw SecurityException("release denied")
    })
  }

  @Test
  fun revokedGrantDuringReleaseIsSettled() {
    var retained = true
    assertTrue(releasePersistedReadPermission(uri, { retained }) {
      retained = false
      throw SecurityException("grant already revoked")
    })
  }
}
