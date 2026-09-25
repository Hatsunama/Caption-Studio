package app.captionstudio.media

import android.content.ContentValues
import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import java.io.File
import kotlin.math.abs

internal data class VerifiedRenderedVideo(
  val sizeBytes: Long,
  val durationMs: Long,
  val width: Int,
  val height: Int,
  val hasAudioTrack: Boolean = false,
)

internal fun requireExpectedOutput(
  verified: VerifiedRenderedVideo,
  expectedWidth: Int,
  expectedHeight: Int,
  audioExpected: Boolean,
): VerifiedRenderedVideo {
  check(verified.width == expectedWidth && verified.height == expectedHeight) {
    "The rendered video dimensions do not match the requested canvas"
  }
  check(!audioExpected || verified.hasAudioTrack) { "The exported video has no audio track" }
  return verified
}

internal fun requireRenderedVideoFile(file: File): Long {
  check(file.isFile) { "The rendered video file is missing" }
  val size = file.length()
  check(size > 0L) { "The rendered video file is empty" }
  return size
}

internal fun inspectRenderedVideo(
  context: Context,
  uri: Uri,
  expectedSize: Long,
  expectedDurationMs: Long,
  frameRate: Int,
): VerifiedRenderedVideo {
  if (uri.scheme.isNullOrEmpty() || uri.scheme == "file") {
    val path = uri.path ?: throw IllegalStateException("The rendered video path is invalid")
    val file = File(path)
    check(file.isFile && file.length() == expectedSize) { "The exported video file is incomplete" }
  } else {
    val descriptorSize = context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { descriptor ->
      descriptor.declaredLength
    } ?: throw IllegalStateException("Android could not reopen the exported video")
    if (descriptorSize >= 0L) {
      check(descriptorSize == expectedSize) { "Android saved an incomplete exported video" }
    }
  }

  val extractor = MediaExtractor()
  val retriever = MediaMetadataRetriever()
  try {
    setRenderedVideoDataSource(context, extractor, retriever, uri)
    var hasVideo = false
    var hasAudio = false
    var width = 0
    var height = 0
    var durationMs = 0L
    for (index in 0 until extractor.trackCount) {
      val format = extractor.getTrackFormat(index)
      val mime = format.getString(MediaFormat.KEY_MIME).orEmpty()
      if (mime.startsWith("audio/")) hasAudio = true
      if (!mime.startsWith("video/")) continue
      hasVideo = true
      width = mediaFormatInt(format, MediaFormat.KEY_WIDTH)
      height = mediaFormatInt(format, MediaFormat.KEY_HEIGHT)
      val videoTrackDurationMs = if (format.containsKey(MediaFormat.KEY_DURATION)) {
        format.getLong(MediaFormat.KEY_DURATION) / 1_000L
      } else 0L
      durationMs = maxOf(
        durationMs,
        requireMatchingVideoTrackDuration(videoTrackDurationMs, expectedDurationMs, frameRate),
      )
    }
    check(hasVideo) { "The export does not contain a video track" }
    val retrieverDuration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
    check(maxOf(durationMs, retrieverDuration) > 0L) { "The export has no readable duration" }
    val retrieverWidth = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
    val retrieverHeight = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
    width = width.takeIf { it > 0 } ?: retrieverWidth
    height = height.takeIf { it > 0 } ?: retrieverHeight
    check(width in 2..3840 && height in 2..3840 && width % 2 == 0 && height % 2 == 0) {
      "The export dimensions are invalid"
    }
    return VerifiedRenderedVideo(expectedSize, durationMs, width, height, hasAudio)
  } finally {
    extractor.release()
    retriever.release()
  }
}

internal fun requireMatchingVideoTrackDuration(videoTrackDurationMs: Long, expectedDurationMs: Long, frameRate: Int): Long {
  require(expectedDurationMs > 0L && frameRate > 0) { "The requested render duration or frame rate is invalid" }
  check(videoTrackDurationMs > 0L) { "The export has no readable video-track duration" }
  val toleranceMs = (2_000L + frameRate - 1) / frameRate + 20L
  check(abs(videoTrackDurationMs - expectedDurationMs) <= toleranceMs) {
    "The exported video track duration does not match the requested render duration"
  }
  return videoTrackDurationMs
}

internal fun pendingVideoContentValues(displayName: String): ContentValues {
  return ContentValues().apply {
    put(MediaStore.Video.Media.DISPLAY_NAME, displayName)
    put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
    put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/Caption Studio")
    put(MediaStore.Video.Media.IS_PENDING, 1)
  }
}

internal fun finishedVideoContentValues(verified: VerifiedRenderedVideo, nowMs: Long = System.currentTimeMillis()): ContentValues {
  return ContentValues().apply {
    put(MediaStore.Video.Media.IS_PENDING, 0)
    put(MediaStore.Video.Media.SIZE, verified.sizeBytes)
    put(MediaStore.Video.Media.DURATION, verified.durationMs)
    put(MediaStore.Video.Media.WIDTH, verified.width)
    put(MediaStore.Video.Media.HEIGHT, verified.height)
    put(MediaStore.Video.Media.DATE_ADDED, nowMs / 1_000L)
    put(MediaStore.Video.Media.DATE_MODIFIED, nowMs / 1_000L)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      put(MediaStore.Video.Media.DATE_TAKEN, nowMs)
    }
  }
}

private fun setRenderedVideoDataSource(
  context: Context,
  extractor: MediaExtractor,
  retriever: MediaMetadataRetriever,
  uri: Uri,
) {
  if (uri.scheme.isNullOrEmpty() || uri.scheme == "file") {
    val path = uri.path ?: throw IllegalStateException("The exported video path is invalid")
    extractor.setDataSource(path)
    retriever.setDataSource(path)
  } else {
    extractor.setDataSource(context, uri, null)
    retriever.setDataSource(context, uri)
  }
}

private fun mediaFormatInt(format: MediaFormat, key: String): Int {
  return if (format.containsKey(key)) format.getInteger(key) else 0
}
