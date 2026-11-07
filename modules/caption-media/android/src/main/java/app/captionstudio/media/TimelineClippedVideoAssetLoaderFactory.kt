package app.captionstudio.media

import android.content.Context
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.Clock
import androidx.media3.common.util.ExperimentalApi
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.mp4.Mp4Extractor
import androidx.media3.transformer.AssetLoader
import androidx.media3.transformer.Codec
import androidx.media3.transformer.DefaultAssetLoaderFactory
import androidx.media3.transformer.DefaultDecoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.ExoPlayerAssetLoader

/** Opts finite native video exports into Media3's media-period end clipping. */
@OptIn(UnstableApi::class, ExperimentalApi::class)
internal class TimelineClippedVideoAssetLoaderFactory(
  private val context: Context,
  private val defaultFactory: AssetLoader.Factory,
  // Narrow adapter-test seam: receives the same configured source factory used in production.
  private val clippedFactory: (DefaultMediaSourceFactory) -> AssetLoader.Factory,
) : AssetLoader.Factory {
  constructor(context: Context) : this(
    context.applicationContext, DefaultDecoderFactory.Builder(context).build(),
  )

  private constructor(context: Context, decoderFactory: Codec.DecoderFactory) : this(
    context,
    // Preserve Media3's SRGB/4096 image loader, executor, and default non-clipped paths.
    // Public custom factories cannot access Transformer's internal EditingSession LogSessionId.
    // Null is unavoidable here; this factory makes no diagnostic-session association claim.
    DefaultAssetLoaderFactory(context, decoderFactory, Clock.DEFAULT, null),
    { mediaSourceFactory ->
      // The four-argument overload preserves the default track selector and load control.
      ExoPlayerAssetLoader.Factory(context, decoderFactory, Clock.DEFAULT, mediaSourceFactory)
    },
  )

  override fun createAssetLoader(
    editedMediaItem: EditedMediaItem,
    looper: Looper,
    listener: AssetLoader.Listener,
    compositionSettings: AssetLoader.CompositionSettings,
  ): AssetLoader {
    val mediaItem = editedMediaItem.mediaItem
    val endUs = mediaItem.clippingConfiguration.endPositionUs
    val isClippedVideo = editedMediaItem.removeAudio && !editedMediaItem.removeVideo &&
      mediaItem.localConfiguration?.imageDurationMs == C.TIME_UNSET && endUs >= 0L
    val factory = if (isClippedVideo) {
      val extractors = DefaultExtractorsFactory()
      if (editedMediaItem.flattenForSlowMotion) {
        extractors.setMp4ExtractorFlags(Mp4Extractor.FLAG_READ_SEF_DATA)
      }
      clippedFactory(DefaultMediaSourceFactory(context, extractors).setEnableClippingInMediaPeriod(true))
    } else {
      defaultFactory
    }
    // Return the native loader itself; Transformer owns progress, errors, release and cancellation.
    return factory.createAssetLoader(editedMediaItem, looper, listener, compositionSettings)
  }
}
