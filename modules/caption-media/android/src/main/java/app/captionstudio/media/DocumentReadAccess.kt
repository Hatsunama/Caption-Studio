package app.captionstudio.media

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import java.io.FileNotFoundException
import java.io.IOException

/** Owns the Android grant, not the player's decoder or cached poster. Never copies media. */
internal class DocumentReadAccess(private val resolver: ContentResolver) {
  fun retained(uri: Uri): Boolean = resolver.persistedUriPermissions.any {
    it.uri == uri && it.isReadPermission
  }

  fun retain(uri: Uri) {
    require(uri.scheme == "content") { "Select a video document from Android Files." }
    resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
    check(retained(uri)) { "Android did not retain access. Select the original video again from Files." }
    open(uri)
  }

  fun retainResult(uri: Uri, flags: Int) {
    val required = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
    check(flags and required == required) {
      "This provider did not offer lasting read access. Choose the original video from a Files provider that supports document access."
    }
    retain(uri)
  }

  fun check(input: String): Map<String, Any> {
    val uri = Uri.parse(input)
    return try {
      // An older import may still hold an offered, but untaken, persistable grant.
      // This cannot invent a grant after Android has revoked it.
      if (uri.scheme == "content" && !retained(uri)) {
        try {
          resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: SecurityException) {
          // Report the actual read/grant state below; never treat temporary access as durable.
        }
      }
      open(uri)
      result(if (uri.scheme != "content" || retained(uri)) "ready" else "permission-required")
    } catch (_: SecurityException) {
      result("permission-required")
    } catch (_: FileNotFoundException) {
      result("missing")
    } catch (_: IOException) {
      result("unavailable")
    } catch (_: IllegalArgumentException) {
      result("unavailable")
    }
  }

  private fun open(uri: Uri) {
    resolver.openAssetFileDescriptor(uri, "r")?.use { }
      ?: throw FileNotFoundException("The video document is unavailable.")
  }

  private fun result(status: String): Map<String, Any> = mapOf("status" to status)
}
