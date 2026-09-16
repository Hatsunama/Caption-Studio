package app.captionstudio.media

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import expo.modules.kotlin.Promise

/** Keep result flags and grant acquisition together, before any URI crosses the JS bridge. */
internal class LinkedVideoDocuments(private val context: Context) {
  private var pending: Promise? = null
  private var allowMultiple = false

  fun launch(activity: Activity, multiple: Boolean, promise: Promise) {
    if (pending != null) {
      promise.reject("E_DOCUMENT_PICKER_BUSY", "A video document selection is already open.", null)
      return
    }
    pending = promise
    allowMultiple = multiple
    try {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "video/*"
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
      }
      activity.startActivityForResult(intent, REQUEST_CODE)
    } catch (error: Exception) {
      pending = null
      promise.reject("E_DOCUMENT_PICKER", "Android Files could not be opened. Your project is unchanged.", error)
    }
  }

  fun onResult(requestCode: Int, resultCode: Int, intent: Intent?) {
    if (requestCode != REQUEST_CODE) return
    val promise = pending ?: return
    pending = null
    if (resultCode == Activity.RESULT_CANCELED) {
      promise.resolve(mapOf("canceled" to true, "assets" to emptyList<Any>()))
      return
    }
    try {
      check(resultCode == Activity.RESULT_OK && intent != null) { "Android Files did not return a video document." }
      val uris = linkedSetOf<Uri>()
      intent.data?.let(uris::add)
      intent.clipData?.let { clips ->
        for (index in 0 until clips.itemCount) uris.add(clips.getItemAt(index).uri)
      }
      check(uris.isNotEmpty() && (allowMultiple || uris.size == 1)) { "Select the original video document." }
      val access = DocumentReadAccess(context.contentResolver)
      // If a later document fails, retain earlier grants: they may belong to another project.
      // Never revoke provider access speculatively from the picker.
      uris.forEach { access.retainResult(it, intent.flags) }
      val assets = uris.map(::details)
      promise.resolve(mapOf("canceled" to false, "assets" to assets))
    } catch (error: Exception) {
      promise.reject("E_DOCUMENT_ACCESS", error.message ?: "Lasting video access was not granted. Select the original file again.", error)
    }
  }

  private fun details(uri: Uri): Map<String, Any?> {
    val resolver = context.contentResolver
    var name = uri.lastPathSegment ?: "Video"
    var size: Long? = null
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) {
        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
        if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex).takeIf { it >= 0 }
      }
    }
    return mapOf("uri" to uri.toString(), "name" to name, "size" to size, "mimeType" to resolver.getType(uri))
  }

  companion object {
    private const val REQUEST_CODE = 48173
  }
}
