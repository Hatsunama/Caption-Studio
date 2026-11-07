package app.captionstudio.media

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.ExperimentalApi
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.analytics.PlayerId
import androidx.media3.exoplayer.source.ClippingMediaPeriod
import androidx.media3.exoplayer.source.MediaPeriod
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.exoplayer.upstream.Allocator
import androidx.media3.exoplayer.upstream.BandwidthMeter
import androidx.media3.exoplayer.upstream.DefaultAllocator
import androidx.media3.exoplayer.upstream.DefaultBandwidthMeter
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy

/** Real factory/MediaItem/ClippingMediaPeriod, with only the I/O child period replaced. */
@OptIn(UnstableApi::class, ExperimentalApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE, shadows = [VideoPlaybackWindowSourceTest.ChildPeriod::class])
class VideoPlaybackWindowSourceTest {
  @Test fun nativeFactoryPropagatesExactEndToChildAndClearUsesFullSource() {
    val context = RuntimeEnvironment.getApplication()
    val original = MediaItem.fromUri("content://documents/approved")
    val cap = VideoPlaybackWindow.copyItem(original, original.localConfiguration!!.uri.toString(), 6375L)
    val cleared = VideoPlaybackWindow.copyItem(cap, original.localConfiguration!!.uri.toString(), null)
    val ends = mutableListOf<Long>()
    ChildPeriod.period = Proxy.newProxyInstance(MediaPeriod::class.java.classLoader, arrayOf(MediaPeriod::class.java)) { _, method, args ->
      if (method.name == "setEndPositionUs") { ends += args!![0] as Long; null }
      else throw AssertionError("Unexpected child call: ${method.name}")
    } as MediaPeriod
    val factory = VideoPlaybackWindow.sourceFactory(context)
    listOf(cap, cleared).forEach { item ->
      val source = factory.createMediaSource(item)
      assertSame(item, source.mediaItem)
      var uid: Any? = null
      val caller = MediaSource.MediaSourceCaller { _, timeline -> uid = timeline.getUidOfPeriod(0) }
      // Same test-only version adapter as the existing native export regression suite.
      val prepare = try {
        MediaSource::class.java.getMethod("prepareSource", MediaSource.MediaSourceCaller::class.java,
          PlayerId::class.java, BandwidthMeter::class.java)
      } catch (_: NoSuchMethodException) { null }
      if (prepare == null) source.prepareSource(caller, null, PlayerId.UNSET)
      else try {
        prepare.invoke(source, caller, PlayerId.UNSET, DefaultBandwidthMeter.getSingletonInstance(context))
      } catch (failure: InvocationTargetException) { throw failure.targetException }
      try {
        val period = source.createPeriod(MediaSource.MediaPeriodId(requireNotNull(uid)), DefaultAllocator(true, 1024), 0L)
        try {
          if (item === cap) {
            assertTrue(period is ClippingMediaPeriod)
            assertEquals(6_375_000L, ends.last())
            (period as ClippingMediaPeriod).updateClipping(0L, 6_385_000L)
            assertEquals(6_385_000L, ends.last())
          } else {
            assertFalse(period is ClippingMediaPeriod)
            assertSame(ChildPeriod.period, period)
            assertEquals(C.TIME_END_OF_SOURCE, item.clippingConfiguration.endPositionUs)
          }
        } finally { source.releasePeriod(period) }
      } finally { source.releaseSource(caller) }
    }
  }

  @Test fun copiedItemPreservesSdkResponsibilitiesAndRejectsUnsupportedConfiguration() {
    val uri = "content://documents/approved"
    val tag = Any()
    val subtitle = MediaItem.SubtitleConfiguration.Builder(android.net.Uri.parse("content://documents/subtitle"))
      .setMimeType("text/vtt").build()
    val original = MediaItem.Builder().setUri(uri).setMediaId("sdk-id").setTag(tag)
      .setSubtitleConfigurations(listOf(subtitle)).build()
    val copy = VideoPlaybackWindow.copyItem(original, uri, 6385L)
    assertSame(tag, copy.localConfiguration!!.tag)
    assertEquals(original.mediaId, copy.mediaId)
    assertEquals(original.localConfiguration!!.subtitleConfigurations, copy.localConfiguration!!.subtitleConfigurations)
    assertThrows(IllegalArgumentException::class.java) { VideoPlaybackWindow.copyItem(original, "$uri/other", 1) }
    val unsupported = listOf(
      original.buildUpon().setCustomCacheKey("private").build(),
      original.buildUpon().setDrmConfiguration(MediaItem.DrmConfiguration.Builder(C.WIDEVINE_UUID).build()).build(),
      original.buildUpon().setClippingConfiguration(MediaItem.ClippingConfiguration.Builder()
        .setRelativeToDefaultPosition(true).build()).build(),
    )
    unsupported.forEach { item ->
      assertThrows(IllegalArgumentException::class.java) { VideoPlaybackWindow.copyItem(item, uri, null) }
    }
  }

  @Implements(ProgressiveMediaSource::class)
  class ChildPeriod {
    companion object { lateinit var period: MediaPeriod }
    @Implementation fun createPeriod(id: MediaSource.MediaPeriodId, allocator: Allocator, startPositionUs: Long): MediaPeriod = period
    @Implementation fun releasePeriod(period: MediaPeriod) = Unit
  }
}
