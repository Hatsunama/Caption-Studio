package app.captionstudio.media

import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.GlObjectsProvider
import androidx.media3.common.GlTextureInfo
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.VideoFrameProcessingException
import androidx.media3.effect.GlShaderProgram
import androidx.media3.transformer.AssetLoader
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.SampleConsumer
import androidx.media3.transformer.Transformer
import com.google.common.collect.ImmutableMap
import java.lang.reflect.Proxy
import java.util.concurrent.Executor
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** PRIVATE DISPOSABLE: actual adapter and shader protocol, MOCK native decode/GL boundary.
 * Does not prove H264 reordering or export pixels; the strict real-APK oracle must still pass.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class PrivateDisposableBFrameReadAheadTest {
  private val context get() = RuntimeEnvironment.getApplication()
  private val settings = AssetLoader.CompositionSettings(Composition.HDR_MODE_KEEP_HDR, false)
  private val format = Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).build()

  @Test
  fun actualExporterBuilderKeepsOriginalPresentationAndGapAndOnlyMarksFirstFootage() {
    val exporter = TimelineVideoExporter(context)
    try {
      val canvas = MediaItem.Builder().setUri("content://private-test/canvas")
        .setMimeType(MimeTypes.IMAGE_PNG).setImageDurationMs(8_500).build()
      val original = exporter.buildNativeVideoSequence(plan(), canvas).editedMediaItems
      val probe = exporter.buildNativeVideoSequence(plan(), canvas, 8_000).editedMediaItems
      assertEquals(3, probe.size)
      assertEquals(0L, probe[0].mediaItem.clippingConfiguration.startPositionUs)
      assertEquals(6_385_000L, probe[0].mediaItem.clippingConfiguration.endPositionUs)
      assertTrue(probe[0].effects.videoEffects.first() is PrivateDisposableBFrameTailEffect)
      assertEquals(original[0].effects.videoEffects.single()::class.java, probe[0].effects.videoEffects.last()::class.java)
      assertEquals(original[0].durationUs, probe[0].durationUs)
      assertEquals(original[0].frameRate, probe[0].frameRate)
      // Leave original source duration unset as in the product builder; do not put the retained
      // output duration into EditedMediaItem's BEFORE-clipping source-duration metadata.
      assertEquals(C.TIME_UNSET, probe[0].durationUs)
      assertEquals(500_000L, probe[1].durationUs)
      assertTrue(probe[1].effects.videoEffects.single() is TimelineVideoGapEffect)
      assertEquals(original[1].mediaItem, probe[1].mediaItem)
      assertEquals(original[2].mediaItem, probe[2].mediaItem)
      assertEquals(6_385_000L, probe[2].mediaItem.clippingConfiguration.startPositionUs)
      assertEquals(8_000_000L, probe[2].mediaItem.clippingConfiguration.endPositionUs)
      assertFalse(probe[2].effects.videoEffects.any { it is PrivateDisposableBFrameTailEffect })
      assertEquals(original[2].mediaItem.mediaId, probe[2].mediaItem.mediaId)
    } finally { exporter.close() }
  }

  @Test
  fun gateRejectsEveryChangedProfileFieldAndMissingSourceDuration() {
    val fixture = plan()
    assertTrue(PrivateDisposableBFrameReadAhead.matches(fixture, 8_000))
    listOf(null, 7_999L, 8_001L).forEach { assertFalse(PrivateDisposableBFrameReadAhead.matches(fixture, it)) }
    val changed = listOf(fixture.copy(durationMs = 8_501), fixture.copy(width = 1079),
      fixture.copy(height = 1919), fixture.copy(frameRate = 25), fixture.copy(clips = emptyList()),
      fixture.copy(clips = fixture.clips.take(1))) +
      listOf(fixture.clips[0].copy(sourceStartMs = 1), fixture.clips[0].copy(sourceEndMs = 6_384),
        fixture.clips[0].copy(timelineStartMs = 1), fixture.clips[0].copy(timelineEndMs = 6_384),
        fixture.clips[0].copy(playbackRate = 2f), fixture.clips[0].copy(transitionType = "crossfade"),
        fixture.clips[0].copy(transitionDurationMs = 1)).map { fixture.copy(clips = listOf(it, fixture.clips[1])) } +
      listOf(fixture.clips[1].copy(uri = "content://private-test/other"),
        fixture.clips[1].copy(sourceStartMs = 6_384), fixture.clips[1].copy(sourceEndMs = 8_001),
        fixture.clips[1].copy(timelineStartMs = 6_884), fixture.clips[1].copy(timelineEndMs = 8_499),
        fixture.clips[1].copy(playbackRate = 0.5f), fixture.clips[1].copy(transitionType = "crossfade"),
        fixture.clips[1].copy(transitionDurationMs = 1)).map { fixture.copy(clips = listOf(fixture.clips[0], it)) }
    changed.forEach { assertFalse(PrivateDisposableBFrameReadAhead.matches(it, 8_000)) }
  }

  @Test
  fun wrapperChangesOnlyDelegateReadEndAndDurationAndReturnsActualLoader() {
    val boundary = NativeBoundary()
    val listener = RecordingListener()
    val item = PrivateDisposableBFrameReadAhead.firstFootage(video())
    val loader = PrivateDisposableBFrameReadAhead(boundary).createAssetLoader(item, Looper.getMainLooper(), listener, settings)
    assertSame(boundary.loader, loader)
    assertSame(settings, boundary.settings)
    assertSame(Looper.getMainLooper(), boundary.looper)
    assertEquals(6_416_668L, boundary.item.mediaItem.clippingConfiguration.endPositionUs)
    assertEquals(6_385_000L, item.mediaItem.clippingConfiguration.endPositionUs)
    assertEquals(item.durationUs, boundary.item.durationUs)
    assertSame(item.speedProvider, boundary.item.speedProvider)
    assertSame(item.effects, boundary.item.effects)
    assertEquals(item.frameRate, boundary.item.frameRate)
    assertEquals(item.flattenForSlowMotion, boundary.item.flattenForSlowMotion)
    boundary.listener.onDurationUs(6_416_668)
    boundary.listener.onTrackCount(1)
    assertTrue(boundary.listener.onTrackAdded(format, AssetLoader.SUPPORTED_OUTPUT_TYPE_DECODED))
    assertEquals(listOf("duration:6385000", "tracks:1", "track"), listener.events)
    assertSame(format, listener.format)
    assertEquals(AssetLoader.SUPPORTED_OUTPUT_TYPE_DECODED, listener.types)
    assertNull(boundary.listener.onOutputFormat(format)) // Retry must stay null.
    val consumer = consumer { _, _ -> null }
    listener.consumer = consumer
    assertSame(consumer, boundary.listener.onOutputFormat(format))
    listener.decode = false
    assertFalse(boundary.listener.onTrackAdded(format, AssetLoader.SUPPORTED_OUTPUT_TYPE_ENCODED))
    loader.start()
    val progress = ProgressHolder()
    assertEquals(Transformer.PROGRESS_STATE_AVAILABLE, loader.getProgress(progress))
    assertEquals(37, progress.progress)
    assertSame(boundary.loader.names, loader.decoderNames)
    // Cancellation is Transformer releasing this exact loader; no adapter lifecycle to bypass it.
    loader.release()
    assertEquals(listOf("start", "progress", "names", "release"), boundary.loader.events)
  }

  @Test
  fun assetAndOutputFormatFailuresForwardIdenticallyAndReleaseRemainsNative() {
    val boundary = NativeBoundary()
    val listener = RecordingListener()
    val loader = PrivateDisposableBFrameReadAhead(boundary).createAssetLoader(
      PrivateDisposableBFrameReadAhead.firstFootage(video()), Looper.getMainLooper(), listener, settings)
    val failure = ExportException.createForAssetLoader(IllegalStateException("mock native failure"), ExportException.ERROR_CODE_UNSPECIFIED)
    boundary.listener.onError(failure)
    assertSame(failure, listener.error)
    listener.outputFailure = failure
    try {
      boundary.listener.onOutputFormat(format)
      fail("Output-format exception was swallowed")
    } catch (actual: ExportException) { assertSame(failure, actual) }
    loader.release()
    assertEquals(listOf("release"), boundary.loader.events)
  }

  @Test
  fun unexpectedOrUnknownNativeReadDurationFailsRatherThanInventingRetainedDuration() {
    listOf(C.TIME_UNSET, 6_385_000L, 6_416_667L, 8_000_000L).forEach { duration ->
      val boundary = NativeBoundary()
      val listener = RecordingListener()
      val loader = PrivateDisposableBFrameReadAhead(boundary).createAssetLoader(
        PrivateDisposableBFrameReadAhead.firstFootage(video()), Looper.getMainLooper(), listener, settings)
      boundary.listener.onDurationUs(duration)
      assertTrue(listener.events.isEmpty())
      assertTrue(listener.error?.cause is IllegalStateException)
      loader.release()
      assertEquals(listOf("release"), boundary.loader.events)
    }
  }

  @Test
  fun untaggedNonfixtureSecondClipAudioAndImagesDelegateUnchanged() {
    val selected = PrivateDisposableBFrameReadAhead.firstFootage(video())
    val image = EditedMediaItem.Builder(MediaItem.Builder().setUri("content://private-test/image")
      .setMimeType(MimeTypes.IMAGE_PNG).setImageDurationMs(500).build()).build()
    val audio = EditedMediaItem.Builder(video().mediaItem).setRemoveVideo(true).build()
    val second = EditedMediaItem.Builder(video().mediaItem.buildUpon().setClippingConfiguration(
      MediaItem.ClippingConfiguration.Builder().setStartPositionMs(6_385).setEndPositionMs(8_000).build()).build())
      .setRemoveAudio(true).build()
    val wrongTrim = PrivateDisposableBFrameReadAhead.firstFootage(EditedMediaItem.Builder(
      video().mediaItem.buildUpon().setClippingConfiguration(MediaItem.ClippingConfiguration.Builder()
        .setEndPositionMs(6_384).build()).build()).setRemoveAudio(true).build())
    listOf(video(), second, audio, image, wrongTrim, selected.buildUpon().setRemoveAudio(false).build()).forEach { item ->
      val boundary = NativeBoundary()
      val listener = RecordingListener()
      assertSame(boundary.loader, PrivateDisposableBFrameReadAhead(boundary)
        .createAssetLoader(item, Looper.getMainLooper(), listener, settings))
      assertSame(item, boundary.item)
      assertSame(listener, boundary.listener)
      boundary.listener.onDurationUs(123)
      assertEquals(listOf("duration:123"), listener.events)
    }
  }

  @Test
  fun actualShaderPassesBFrameDropsFutureReferenceReturnsTexturesAndForwardsEosFlush() {
    val program = PrivateDisposableBFrameTailEffect().toGlShaderProgram(context, false)
    val returned = mutableListOf<GlTextureInfo>()
    val output = mutableListOf<Long>()
    var ready = 0
    var eos = 0
    var flushes = 0
    program.setInputListener(object : GlShaderProgram.InputListener {
      override fun onReadyToAcceptInputFrame() { ready++ }
      override fun onInputFrameProcessed(texture: GlTextureInfo) { returned += texture }
      override fun onFlush() { flushes++ }
    })
    program.setOutputListener(object : GlShaderProgram.OutputListener {
      override fun onOutputFrameAvailable(texture: GlTextureInfo, pts: Long) {
        output += pts
        program.releaseOutputFrame(texture)
      }
      override fun onCurrentOutputStreamEnded() { eos++ }
    })
    program.setErrorListener(Executor { it.run() }) { throw AssertionError(it) }
    // MOCK native consumer boundary: exercise the actual returned consumer and GL implementation,
    // not a copied clipping/decoder algorithm. Media3 non-looping registerVideoFrame has no end
    // duration check; VideoEncoderGraphInput calls registerInputFrame WITHOUT passing a PTS.
    val boundary = NativeBoundary()
    val listener = RecordingListener()
    listener.consumer = consumer { name, args ->
      when (name) {
        "registerVideoFrame" -> true
        "queueInputTexture" -> {
          program.queueInputFrame(provider(), texture(args!![0] as Int), args[1] as Long)
          SampleConsumer.INPUT_RESULT_SUCCESS
        }
        "signalEndOfVideoInput" -> { program.signalEndOfCurrentInputStream(); null }
        else -> throw AssertionError("Unexpected consumer method: $name")
      }
    }
    val loader = PrivateDisposableBFrameReadAhead(boundary).createAssetLoader(
      PrivateDisposableBFrameReadAhead.firstFootage(video()), Looper.getMainLooper(), listener, settings)
    boundary.listener.onDurationUs(6_416_668)
    val nativeConsumer = requireNotNull(boundary.listener.onOutputFormat(format))
    val pts = listOf(6_333_333L, 6_375_000L, 6_384_999L, 6_385_000L, 6_416_667L)
    pts.forEachIndexed { index, time ->
      assertTrue(nativeConsumer.registerVideoFrame(time))
      assertEquals(SampleConsumer.INPUT_RESULT_SUCCESS, nativeConsumer.queueInputTexture(index + 1, time))
    }
    assertEquals(pts.take(3), output)
    assertEquals((1..5).toList(), returned.map { it.texId })
    assertEquals(6, ready)
    nativeConsumer.signalEndOfVideoInput()
    program.flush()
    program.signalEndOfCurrentInputStream() // An empty stream must also end.
    assertEquals(2, eos)
    assertEquals(1, flushes)
    assertEquals(7, ready)
    loader.release()
    program.release()
    assertEquals(5, returned.size)
  }

  @Test
  fun shaderCallbackFailureUsesErrorExecutorAndNeverRetriesTextureReturnOnRelease() {
    val program = PrivateDisposableBFrameTailEffect().toGlShaderProgram(context, false)
    val pending = mutableListOf<Runnable>()
    val errors = mutableListOf<VideoFrameProcessingException>()
    val failure = IllegalStateException("mock producer failed")
    var returns = 0
    program.setInputListener(object : GlShaderProgram.InputListener {
      override fun onInputFrameProcessed(texture: GlTextureInfo) { returns++; throw failure }
    })
    program.setErrorListener(Executor { pending += it }) { errors += it }
    program.queueInputFrame(provider(), texture(1), 6_416_667)
    assertEquals(1, returns)
    assertTrue(errors.isEmpty())
    pending.single().run()
    assertSame(failure, errors.single().cause)
    program.release()
    assertEquals(1, returns)
  }

  @Test
  fun retainedTextureOwnershipAndCancellationFlushUseRealPassthroughProtocol() {
    val effect = PrivateDisposableBFrameTailEffect()
    assertFalse(effect.isNoOp(32, 32))
    val program = effect.toGlShaderProgram(context, false)
    val retained = texture(11)
    val tail = texture(12)
    val returned = mutableListOf<GlTextureInfo>()
    var output: GlTextureInfo? = null
    var capacity = 0
    var flushes = 0
    program.setInputListener(object : GlShaderProgram.InputListener {
      override fun onReadyToAcceptInputFrame() { capacity++ }
      override fun onInputFrameProcessed(texture: GlTextureInfo) { returned += texture }
      override fun onFlush() { capacity = 0; flushes++ }
    })
    program.setOutputListener(object : GlShaderProgram.OutputListener {
      override fun onOutputFrameAvailable(texture: GlTextureInfo, pts: Long) {
        assertEquals(6_375_000L, pts); output = texture
      }
    })
    capacity--
    program.queueInputFrame(provider(), retained, 6_375_000)
    assertSame(retained, output)
    assertEquals(0, capacity)
    assertTrue(returned.isEmpty())
    program.releaseOutputFrame(retained)
    assertSame(retained, returned.single())
    assertEquals(1, capacity)
    capacity--
    program.queueInputFrame(provider(), tail, 6_416_667)
    assertSame(retained, output) // Tail generated no new output or downstream ownership.
    assertSame(tail, returned.last())
    assertEquals(1, capacity)
    program.flush() // Cancellation/reset delegates to PassthroughShaderProgram.
    program.release()
    program.release()
    assertEquals(1, flushes)
    assertEquals(1, capacity)
    assertEquals(listOf(retained, tail), returned)
  }

  private class NativeLoader : AssetLoader {
    val events = mutableListOf<String>()
    val names: ImmutableMap<Int, String> = ImmutableMap.of(C.TRACK_TYPE_VIDEO, "mock-native-decoder")
    override fun start() { events += "start" }
    override fun getProgress(holder: ProgressHolder): Int {
      events += "progress"; holder.progress = 37; return Transformer.PROGRESS_STATE_AVAILABLE
    }
    override fun getDecoderNames(): ImmutableMap<Int, String> { events += "names"; return names }
    override fun release() { events += "release" }
  }

  private class NativeBoundary : AssetLoader.Factory {
    val loader = NativeLoader()
    lateinit var item: EditedMediaItem
    lateinit var listener: AssetLoader.Listener
    lateinit var settings: AssetLoader.CompositionSettings
    lateinit var looper: Looper
    override fun createAssetLoader(item: EditedMediaItem, looper: Looper, listener: AssetLoader.Listener,
      compositionSettings: AssetLoader.CompositionSettings): AssetLoader {
      this.item = item; this.listener = listener; this.settings = compositionSettings; this.looper = looper
      return loader
    }
  }

  private class RecordingListener : AssetLoader.Listener {
    val events = mutableListOf<String>()
    var consumer: SampleConsumer? = null
    var error: ExportException? = null
    var outputFailure: ExportException? = null
    var decode = true
    var format: Format? = null
    var types = 0
    override fun onDurationUs(durationUs: Long) { events += "duration:$durationUs" }
    override fun onTrackCount(trackCount: Int) { events += "tracks:$trackCount" }
    override fun onTrackAdded(inputFormat: Format, supportedOutputTypes: Int): Boolean {
      events += "track"; format = inputFormat; types = supportedOutputTypes; return decode
    }
    override fun onOutputFormat(format: Format): SampleConsumer? { outputFailure?.let { throw it }; return consumer }
    override fun onError(exportException: ExportException) { error = exportException }
  }

  private fun consumer(call: (String, Array<out Any?>?) -> Any?): SampleConsumer = Proxy.newProxyInstance(
    SampleConsumer::class.java.classLoader, arrayOf(SampleConsumer::class.java),
  ) { _, method, args -> call(method.name, args) } as SampleConsumer
  private fun provider(): GlObjectsProvider = Proxy.newProxyInstance(
    GlObjectsProvider::class.java.classLoader, arrayOf(GlObjectsProvider::class.java),
  ) { _, method, _ -> throw AssertionError("Unexpected GL access: ${method.name}") } as GlObjectsProvider
  private fun texture(id: Int) = GlTextureInfo(id, id + 100, id + 200, 32, 32)
  private fun video() = EditedMediaItem.Builder(MediaItem.Builder().setUri("content://private-test/fixture")
    .setClippingConfiguration(MediaItem.ClippingConfiguration.Builder().setEndPositionMs(6_385).build()).build())
    .setRemoveAudio(true).build()

  private fun plan(): TimelineRenderPlan {
    val transform = VideoTransform("fit", 0.5f, 0.5f, 1f, 1f, 1f, 0f)
    val first = RenderVideoClip("first", "content://private-test/fixture", 0, 6_385, 0, 8_000,
      0, 6_385, 1f, 1f, false, 0, 0, "none", 0, transform)
    val second = first.copy(id = "second", timelineStartMs = 6_885, timelineEndMs = 8_500,
      sourceStartMs = 6_385, sourceEndMs = 8_000)
    return TimelineRenderPlan(8_500, 1080, 1920, 24, "#000000", false, transform,
      listOf(first, second), emptyList(), emptyList(), emptyList())
  }
}
