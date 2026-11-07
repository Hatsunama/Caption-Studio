package app.captionstudio.media

import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.ExperimentalApi
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.analytics.PlayerId
import androidx.media3.exoplayer.source.ClippingMediaPeriod
import androidx.media3.exoplayer.source.MediaPeriod
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.exoplayer.upstream.Allocator
import androidx.media3.exoplayer.upstream.DefaultAllocator
import androidx.media3.transformer.AssetLoader
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExoPlayerAssetLoader
import androidx.media3.transformer.ImageAssetLoader
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import java.lang.reflect.Proxy

/** JVM adapter/source regression coverage, not decoder, GPU, or physical export proof. */
@OptIn(UnstableApi::class, ExperimentalApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class TimelineClippedVideoAssetLoaderFactoryTest {
  private val context get() = RuntimeEnvironment.getApplication()
  private val looper get() = Looper.getMainLooper()
  private val settings = AssetLoader.CompositionSettings(Composition.HDR_MODE_KEEP_HDR, false)
  private val errors = mutableListOf<ExportException>()
  private val listener = proxy(AssetLoader.Listener::class.java) { name, args ->
    when (name) {
      "onError" -> { errors += args!![0] as ExportException; null }
      "onTrackAdded" -> true
      else -> null
    }
  }

  @Test
  fun onlyFiniteEndVideoOnlyFootageUsesClippedFactoryWithUnchangedArguments() {
    val defaults = RecordingFactory()
    val clipped = RecordingFactory()
    var sourcesCreated = 0
    val factory = TimelineClippedVideoAssetLoaderFactory(context, defaults) {
      sourcesCreated++
      clipped
    }
    val cases = listOf(
      item() to true,
      item(endUs = 1_234_567L) to true,
      item(startUs = 300_000L, endUs = 900_001L) to true,
      item(imageDurationMs = 1_000L, mimeType = MimeTypes.IMAGE_PNG) to false,
      item(imageDurationMs = 1_000L, mimeType = MimeTypes.IMAGE_JPEG) to false,
      item(removeAudio = false, removeVideo = true, mimeType = MimeTypes.AUDIO_AAC) to false,
      item(removeAudio = false) to false,
      item(endUs = C.TIME_END_OF_SOURCE) to false,
      item(startUs = 100L, endUs = C.TIME_END_OF_SOURCE) to false,
    )
    cases.forEach { (item, usesClipping) ->
      val expected = if (usesClipping) clipped else defaults
      val before = sourcesCreated
      assertSame(expected.loader, factory.createAssetLoader(item, looper, listener, settings))
      assertSame(item, expected.item)
      assertSame(looper, expected.looper)
      assertSame(listener, expected.listener)
      assertSame(settings, expected.settings)
      assertEquals(before + if (usesClipping) 1 else 0, sourcesCreated)
    }
    assertEquals(3, clipped.calls)
    assertEquals(6, defaults.calls)
  }

  @Test
  fun productionConstructionReturnsNativeLoadersWithoutStartingThem() {
    val factory = TimelineClippedVideoAssetLoaderFactory(context)
    listOf(
      item() to ExoPlayerAssetLoader::class.java,
      item(endUs = C.TIME_END_OF_SOURCE) to ExoPlayerAssetLoader::class.java,
      item(removeAudio = false, removeVideo = true, mimeType = MimeTypes.AUDIO_AAC) to ExoPlayerAssetLoader::class.java,
      item(imageDurationMs = 1_000L, mimeType = MimeTypes.IMAGE_PNG) to ImageAssetLoader::class.java,
    ).forEach { (item, expectedClass) ->
      val loader = factory.createAssetLoader(item, looper, listener, settings)
      try {
        assertEquals(expectedClass, loader.javaClass)
        assertEquals(Transformer.PROGRESS_STATE_NOT_STARTED, loader.getProgress(ProgressHolder()))
      } finally {
        loader.release()
      }
    }
  }

  @Test
  fun returnedLoaderOwnsProgressErrorsAndReleaseForCancellationOnBothRoutes() {
    listOf(item(), item(endUs = C.TIME_END_OF_SOURCE)).forEach { item ->
      val delegate = RecordingFactory()
      val factory = TimelineClippedVideoAssetLoaderFactory(context, delegate) { delegate }
      val loader = factory.createAssetLoader(item, looper, listener, settings)
      assertSame(delegate.loader, loader)
      // Creation must not start or release the loader. Transformer cancels via release().
      assertTrue(delegate.events.isEmpty())
      loader.start()
      val progress = ProgressHolder()
      assertEquals(Transformer.PROGRESS_STATE_AVAILABLE, loader.getProgress(progress))
      assertEquals(37, progress.progress)
      val error = ExportException.createForAssetLoader(
        IllegalStateException("adapter failure"), ExportException.ERROR_CODE_IO_UNSPECIFIED,
      )
      delegate.listener!!.onError(error)
      assertSame(error, errors.last())
      loader.release()
      assertEquals(listOf("start", "progress", "release"), delegate.events)
    }
  }

  @Test
  fun delegateCreationFailurePropagatesWithoutStartingOrReleasingAnything() {
    val failure = IllegalStateException("creation failure")
    val throwing = AssetLoader.Factory { _, _, _, _ -> throw failure }
    val factory = TimelineClippedVideoAssetLoaderFactory(context, throwing) { throwing }
    listOf(item(), item(endUs = C.TIME_END_OF_SOURCE)).forEach {
      assertSame(failure, assertThrows(IllegalStateException::class.java) {
        factory.createAssetLoader(it, looper, listener, settings)
      })
    }
  }

  @Test
  @Config(shadows = [ChildPeriod::class])
  fun configuredRealMediaSourceDelegatesClippingEndToChildPeriod() {
    val edited = item(startUs = 0L, endUs = 1_234_567L)
    val delegate = RecordingFactory()
    val ends = mutableListOf<Long>()
    ChildPeriod.period = proxy(MediaPeriod::class.java) { name, args ->
      if (name == "setEndPositionUs") (args!![0] as Long).also { ends += it }
      else throw AssertionError("Unexpected child period call: $name")
    }
    var checked = false
    val factory = TimelineClippedVideoAssetLoaderFactory(context, delegate) { sourceFactory ->
      val source = sourceFactory.createMediaSource(edited.mediaItem)
      var periodUid: Any? = null
      val caller = MediaSource.MediaSourceCaller { _, timeline -> periodUid = timeline.getUidOfPeriod(0) }
      source.prepareSource(caller, null, PlayerId.UNSET)
      try {
        val period = source.createPeriod(
          MediaSource.MediaPeriodId(requireNotNull(periodUid)), DefaultAllocator(true, 1024), 0L,
        )
        try {
          assertTrue(period is ClippingMediaPeriod)
          assertEquals(edited.mediaItem.clippingConfiguration.endPositionUs, ends.last())
          // Public behavior verifies propagation, without reflecting private flag fields.
          (period as ClippingMediaPeriod).updateClipping(0L, 987_654L)
          assertEquals(987_654L, ends.last())
          checked = true
        } finally {
          source.releasePeriod(period)
        }
      } finally {
        source.releaseSource(caller)
      }
      delegate
    }
    assertSame(delegate.loader, factory.createAssetLoader(edited, looper, listener, settings))
    assertTrue(checked)
  }

  @Implements(ProgressiveMediaSource::class)
  class ChildPeriod {
    companion object { lateinit var period: MediaPeriod }
    @Implementation
    fun createPeriod(id: MediaSource.MediaPeriodId, allocator: Allocator, startPositionUs: Long): MediaPeriod = period
    @Implementation
    fun releasePeriod(period: MediaPeriod) = Unit
  }

  private fun item(
    startUs: Long = 0L,
    endUs: Long = 2_345_678L,
    removeAudio: Boolean = true,
    removeVideo: Boolean = false,
    imageDurationMs: Long = C.TIME_UNSET,
    mimeType: String = MimeTypes.VIDEO_H264,
  ): EditedMediaItem = EditedMediaItem.Builder(
    MediaItem.Builder().setUri("file:///adapter-input").setMimeType(mimeType)
      .setImageDurationMs(imageDurationMs)
      .setClippingConfiguration(MediaItem.ClippingConfiguration.Builder()
        .setStartPositionUs(startUs).setEndPositionUs(endUs).build()).build(),
  ).setFrameRate(30).setRemoveAudio(removeAudio).setRemoveVideo(removeVideo).build()

  private class RecordingFactory : AssetLoader.Factory {
    var calls = 0
    var item: EditedMediaItem? = null
    var looper: Looper? = null
    var listener: AssetLoader.Listener? = null
    var settings: AssetLoader.CompositionSettings? = null
    val events = mutableListOf<String>()
    val loader = proxy(AssetLoader::class.java) { name, args ->
      events += name
      if (name == "getProgress") {
        events[events.lastIndex] = "progress"
        (args!![0] as ProgressHolder).progress = 37
        Transformer.PROGRESS_STATE_AVAILABLE
      } else null
    }
    override fun createAssetLoader(
      editedMediaItem: EditedMediaItem, looper: Looper, listener: AssetLoader.Listener,
      compositionSettings: AssetLoader.CompositionSettings,
    ): AssetLoader {
      calls++
      item = editedMediaItem
      this.looper = looper
      this.listener = listener
      settings = compositionSettings
      return loader
    }
  }

  companion object {
    @Suppress("UNCHECKED_CAST")
    private fun <T> proxy(type: Class<T>, call: (String, Array<out Any?>?) -> Any?): T =
      Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { _, method, args -> call(method.name, args) } as T
  }
}
