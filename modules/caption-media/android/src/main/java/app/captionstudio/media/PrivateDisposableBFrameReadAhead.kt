package app.captionstudio.media

import android.content.Context
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.GlObjectsProvider
import androidx.media3.common.GlTextureInfo
import androidx.media3.common.MediaItem
import androidx.media3.common.util.Clock
import androidx.media3.effect.GlEffect
import androidx.media3.effect.GlShaderProgram
import androidx.media3.effect.PassthroughShaderProgram
import androidx.media3.transformer.AssetLoader
import androidx.media3.transformer.DefaultAssetLoaderFactory
import androidx.media3.transformer.DefaultDecoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException

/** PRIVATE DISPOSABLE: literal synthetic-fixture experiment, never a general B-frame fix.
 * Source fixture SHA-256: 71e3e0d35a16cc4424f41ffde24b13918b5ea2e91192df6564d1d843c93f9bf9.
 * The numeric gate does NOT authenticate these bytes; real APK pixel verification is mandatory.
 */
internal class PrivateDisposableBFrameReadAhead(private val delegate: AssetLoader.Factory) : AssetLoader.Factory {
  override fun createAssetLoader(
    editedMediaItem: EditedMediaItem,
    looper: Looper,
    listener: AssetLoader.Listener,
    compositionSettings: AssetLoader.CompositionSettings,
  ): AssetLoader {
    val media = editedMediaItem.mediaItem
    val clipping = media.clippingConfiguration
    val selected = media.mediaId == FIRST_FOOTAGE_ID && editedMediaItem.removeAudio &&
      !editedMediaItem.removeVideo && clipping.startPositionUs == 0L &&
      clipping.endPositionUs == RETAINED_US &&
      media.localConfiguration?.imageDurationMs == C.TIME_UNSET &&
      editedMediaItem.effects.videoEffects.firstOrNull() is PrivateDisposableBFrameTailEffect
    if (!selected) return delegate.createAssetLoader(editedMediaItem, looper, listener, compositionSettings)

    // Only the delegate sees the longer CODED read span. The composition keeps its original trim,
    // so EditedMediaItem presentation metadata and all source-provider offsets remain original.
    // Known decode-order prefix: ref 6416667, B 6375000, then 6500000. End is prefix max + 1,
    // NOT a general offset: first crossing EOS becomes 6500000, after the required B picture.
    val readItem = copyVideoWithMedia(editedMediaItem,
      media.buildUpon().setClippingConfiguration(
        clipping.buildUpon().setEndPositionUs(READ_END_US).build(),
      ).build(),
    ).build()
    val outputListener = object : AssetLoader.Listener by listener {
      // Intentional retained OUTPUT duration, not coded read duration.
      // 1.10.1 SequenceAssetLoader uses this for currentAssetDurationUs and sequence advance;
      // VideoEncoderGraphInput uses it for the next stream offset. Neither reclips it.
      // Non-looping SampleConsumerWrapper does not reject future PTS; VideoEncoderGraphInput
      // registers surface frames without a PTS argument, so this read tail can reach the GL filter.
      override fun onDurationUs(durationUs: Long) {
        if (durationUs == READ_END_US) {
          listener.onDurationUs(RETAINED_US)
        } else {
          // Fail closed rather than turn an unknown/unexpected read span into a fake duration.
          listener.onError(ExportException.createForAssetLoader(
            IllegalStateException("PRIVATE DISPOSABLE read span did not match fixture"),
            ExportException.ERROR_CODE_UNSPECIFIED,
          ))
        }
      }
    }
    // Return the actual loader: progress, decoder names, start and release (including cancellation)
    // remain its own. SampleConsumer identity, errors and output-format retry nulls pass through.
    return delegate.createAssetLoader(readItem, looper, outputListener, compositionSettings)
  }

  companion object {
    private const val FIRST_FOOTAGE_ID = "PRIVATE_DISPOSABLE_B_FRAME_FIRST"
    private const val READ_END_US = 6_416_668L
    const val RETAINED_US = 6_385_000L

    fun matches(plan: TimelineRenderPlan, sourceDurationMs: Long?): Boolean {
      if (sourceDurationMs != 8_000L || plan.durationMs != 8_500L || plan.width != 1080 ||
        plan.height != 1920 || plan.frameRate != 24 || plan.clips.size != 2) return false
      val (first, second) = plan.clips
      return first.uri == second.uri && first.sourceStartMs == 0L && first.sourceEndMs == 6_385L &&
        first.timelineStartMs == 0L && first.timelineEndMs == 6_385L &&
        second.sourceStartMs == 6_385L && second.sourceEndMs == 8_000L &&
        second.timelineStartMs == 6_885L && second.timelineEndMs == 8_500L &&
        plan.clips.all { it.playbackRate == 1f && it.transitionType == "none" && it.transitionDurationMs == 0L }
    }

    fun firstFootage(item: EditedMediaItem): EditedMediaItem = copyVideoWithMedia(item,
      item.mediaItem.buildUpon().setMediaId(FIRST_FOOTAGE_ID).build())
      .setEffects(Effects(item.effects.audioProcessors,
        listOf(PrivateDisposableBFrameTailEffect()) + item.effects.videoEffects))
      .build()

    // EditedMediaItem.Builder.setMediaItem is PACKAGE PRIVATE in 1.10.1. Copy only via public
    // setters. This path is video-only: inaccessible preProcessingAudioProcessors cannot apply.
    private fun copyVideoWithMedia(item: EditedMediaItem, media: MediaItem): EditedMediaItem.Builder {
      require(item.removeAudio && !item.removeVideo)
      return EditedMediaItem.Builder(media).setRemoveAudio(true)
        .setFlattenForSlowMotion(item.flattenForSlowMotion).setSpeed(item.speedProvider)
        .setEffects(item.effects).apply {
          if (item.durationUs != C.TIME_UNSET) setDurationUs(item.durationUs)
          if (item.frameRate != C.RATE_UNSET_INT) setFrameRate(item.frameRate)
        }
    }

    fun defaultFactory(context: Context): AssetLoader.Factory = PrivateDisposableBFrameReadAhead(
      // Same constructor as TransformerInternal 1.10.1: preserves default image SRGB, dimension
      // cap/executor, SEF flags, track selection and actual decoder. No MediaSource recreation.
      // PRIVATE DISPOSABLE: internal EditingSession LogSessionId is unavailable here; null loses
      // that diagnostic association. This factory is explicitly NOT product ready.
      DefaultAssetLoaderFactory(context, DefaultDecoderFactory.Builder(context).build(), Clock.DEFAULT, null),
    )
  }
}

/** PRIVATE DISPOSABLE: discard decoded reference pictures outside the retained first-item trim. */
internal class PrivateDisposableBFrameTailEffect : GlEffect {
  override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
    object : PassthroughShaderProgram() {
      override fun queueInputFrame(provider: GlObjectsProvider, texture: GlTextureInfo, timeUs: Long) {
        try {
          if (timeUs < PrivateDisposableBFrameReadAhead.RETAINED_US) {
            super.queueInputFrame(provider, texture, timeUs)
          } else {
            getInputListener().onInputFrameProcessed(texture)
            getInputListener().onReadyToAcceptInputFrame()
          }
        } catch (error: Exception) {
          onError(error)
        }
      }
    }
}
