package app.captionstudio.media

import android.content.Context
import android.net.Uri
import java.io.File

/** Admits document URIs and canonical files owned by this app before media decoders see them. */
internal class MediaInputPolicy(private val context: Context) {
  fun requireInput(value: String): Uri {
    val uri = Uri.parse(value)
    return when (uri.scheme) {
      "content" -> {
        require(!uri.authority.isNullOrBlank()) { "A document provider is required" }
        uri
      }
      "file" -> {
        require(uri.authority.isNullOrEmpty() && uri.query == null && uri.fragment == null) {
          "The selected file URI is invalid"
        }
        val path = uri.path ?: throw IllegalArgumentException("The selected file path is invalid")
        val file = File(path).canonicalFile
        require(file.isAbsolute && ownedRoots().any { file.isWithin(it) }) {
          "Media files must stay inside Caption Studio storage"
        }
        Uri.fromFile(file)
      }
      else -> throw IllegalArgumentException("Select an app file or Android document")
    }
  }

  fun requireOutput(value: String): File {
    val uri = Uri.parse(value)
    require(uri.scheme.isNullOrEmpty() || uri.scheme == "file") { "Output must be an app-local file URI" }
    require(uri.authority.isNullOrEmpty() && uri.query == null && uri.fragment == null) {
      "The output file URI is invalid"
    }
    val file = File(uri.path ?: value).canonicalFile
    require(internalRoots().any { file.isWithin(it) }) { "Output must stay inside Caption Studio storage" }
    return file
  }

  fun requireFontFile(value: String): File {
    require(Uri.parse(value).scheme == "file") {
      "Copy the font into Caption Studio storage before validation"
    }
    return File(requireNotNull(requireInput(value).path))
  }

  private fun internalRoots(): List<File> =
    listOf(context.filesDir, context.cacheDir, context.noBackupFilesDir).map(File::getCanonicalFile)

  private fun ownedRoots(): List<File> = internalRoots() +
    (listOfNotNull(context.externalCacheDir) + context.getExternalFilesDirs(null).filterNotNull() +
      context.externalMediaDirs.filterNotNull()).map(File::getCanonicalFile)

  private fun File.isWithin(root: File): Boolean =
    this == root || path.startsWith(root.path + File.separator)
}
