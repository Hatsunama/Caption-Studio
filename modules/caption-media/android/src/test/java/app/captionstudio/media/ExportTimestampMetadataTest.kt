package app.captionstudio.media

import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.Metadata
import androidx.media3.common.MimeTypes
import androidx.media3.container.Mp4LocationData
import androidx.media3.container.Mp4TimestampData
import androidx.media3.muxer.BufferInfo
import androidx.media3.muxer.Muxer
import androidx.media3.transformer.Composition
import androidx.media3.transformer.InAppMp4Muxer
import androidx.media3.transformer.Transformer
import expo.modules.kotlin.Promise
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.RealObject
import java.io.File
import java.lang.reflect.Proxy
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE, shadows = [ExportTimestampMetadataTest.CaptureEncoderStart::class])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ExportTimestampMetadataTest {
  // Intercept only encoder startup. Exporter preparation, Transformer construction,
  // factory selection, metadata processing and the MP4 writer remain real.
  @Implements(Transformer::class)
  class CaptureEncoderStart {
    @RealObject private lateinit var transformer: Transformer
    @Implementation fun start(composition: Composition, path: String) { started = transformer }
    companion object { var started: Transformer? = null }
  }

  private fun withExportFactory(test: (Muxer.Factory, Long, Long) -> Unit) {
    val context = RuntimeEnvironment.getApplication()
    val directory = File(context.cacheDir, "export-timestamp-${System.nanoTime()}").apply { mkdirs() }
    val failures = mutableListOf<String>()
    val promise = Proxy.newProxyInstance(Promise::class.java.classLoader, arrayOf(Promise::class.java)) { _, method, args ->
      if (method.name == "reject") failures += args?.joinToString().orEmpty()
      null
    } as Promise
    val exporter = TimelineVideoExporter(context)
    CaptureEncoderStart.started = null
    try {
      val before = System.currentTimeMillis()
      exporter.start(File(directory, "export.mp4").absolutePath, TimelineRenderPlan(
        durationMs = 1_000L, width = 360, height = 640, frameRate = 30,
        backgroundColor = "#000000", burnCaptions = false,
        videoTransform = VideoTransform("contain", 0.5f, 0.5f, 1f, 1f, 1f, 0f),
        clips = emptyList(), captions = emptyList(), layers = emptyList(), audioClips = emptyList(),
      ), promise)
      shadowOf(Looper.getMainLooper()).idle()
      val after = System.currentTimeMillis()
      assertTrue("Exporter setup failed before encoder interception: $failures", failures.isEmpty())
      val transformer = checkNotNull(CaptureEncoderStart.started) { "Exporter never reached Transformer.start" }
      // Read the actual factory selected by the application, not a parallel test factory.
      val field = Transformer::class.java.getDeclaredField("muxerFactory").apply { isAccessible = true }
      test(field.get(transformer) as Muxer.Factory, before, after)
    } finally {
      exporter.cancel()
      shadowOf(Looper.getMainLooper()).idle()
      directory.deleteRecursively()
      CaptureEncoderStart.started = null
    }
  }

  @Test fun exporterWiresTimestampProviderThatReplacesOnlyTimestampEntries() = withExportFactory { factory, before, after ->
    assertTrue("The actual exporter must select the timestamp-aware in-app MP4 muxer", factory is InAppMp4Muxer.Factory)
    val field = InAppMp4Muxer.Factory::class.java.getDeclaredField("metadataProvider").apply { isAccessible = true }
    val provider = field.get(factory) as? InAppMp4Muxer.MetadataProvider
    assertNotNull("The exporter-selected factory must have a metadata provider", provider)
    val sourceTime = Mp4TimestampData.unixTimeToMp4TimeSeconds(Instant.parse("2026-10-15T12:00:00Z").toEpochMilli())
    val location = Mp4LocationData(28.5f, -81.3f)
    val entries = linkedSetOf<Metadata.Entry>(Mp4TimestampData(sourceTime, sourceTime),
      Mp4TimestampData(sourceTime - 1, sourceTime - 1), location)
    provider!!.updateMetadataEntries(entries)
    val timestamp = entries.filterIsInstance<Mp4TimestampData>().single()
    assertSame("Unrelated metadata must retain its identity", location, entries.filterIsInstance<Mp4LocationData>().single())
    assertEquals(2, entries.size)
    assertEquals(timestamp.creationTimestampSeconds, timestamp.modificationTimestampSeconds)
    assertTrue(timestamp.creationTimestampSeconds in
      Mp4TimestampData.unixTimeToMp4TimeSeconds(before)..Mp4TimestampData.unixTimeToMp4TimeSeconds(after))
    val second = linkedSetOf<Metadata.Entry>(location)
    provider.updateMetadataEntries(second)
    assertEquals("One captured export time must be reused, including when source timestamps are absent",
      timestamp, second.filterIsInstance<Mp4TimestampData>().single())
  }

  @Test fun exporterSelectedMuxerWritesFreshMovieTrackAndMediaHeaderTimes() = withExportFactory { factory, before, after ->
    assertTrue("Baseline must fail at application factory wiring, not a missing future helper", factory is InAppMp4Muxer.Factory)
    val output = File.createTempFile("caption-header-times-", ".mp4")
    try {
      val sourceTime = Mp4TimestampData.unixTimeToMp4TimeSeconds(Instant.parse("2026-10-15T12:00:00Z").toEpochMilli())
      factory.create(output.absolutePath).use { muxer ->
        val track = muxer.addTrack(Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC)
          .setSampleRate(44_100).setChannelCount(2)
          .setInitializationData(listOf(byteArrayOf(0x12, 0x10))).build())
        muxer.addMetadataEntry(Mp4TimestampData(sourceTime, sourceTime))
        // Container-only fixture: AAC payload is not decoded. Two samples establish duration.
        for (time in listOf(0L, 23_220L)) {
          val sample = ByteBuffer.allocateDirect(4).put(byteArrayOf(1, 2, 3, 4)).apply { flip() }
          muxer.writeSampleData(track, sample, BufferInfo(time, 4, C.BUFFER_FLAG_KEY_FRAME))
        }
      }
      val headers = mutableListOf<Pair<String, Pair<Long, Long>>>()
      readHeaders(ByteBuffer.wrap(output.readBytes()).order(ByteOrder.BIG_ENDIAN), 0, output.length().toInt(), headers)
      assertEquals(setOf("mvhd", "tkhd", "mdhd"), headers.map { it.first }.toSet())
      assertEquals(3, headers.size)
      val timestamps = headers.map { it.second }.distinct()
      assertEquals("All three header types must use the same captured export time", 1, timestamps.size)
      val (creation, modification) = timestamps.single()
      assertEquals(creation, modification)
      assertTrue("MP4 headers retained the source date or used the wrong epoch: $creation",
        creation in Mp4TimestampData.unixTimeToMp4TimeSeconds(before)..Mp4TimestampData.unixTimeToMp4TimeSeconds(after))
    } finally { output.delete() }
  }

  private fun readHeaders(bytes: ByteBuffer, start: Int, end: Int, result: MutableList<Pair<String, Pair<Long, Long>>>) {
    var offset = start
    while (offset + 8 <= end) {
      val size32 = bytes.getInt(offset).toLong() and 0xffffffffL
      val type = (4..7).map { bytes.get(offset + it).toInt().toChar() }.joinToString("")
      val header = if (size32 == 1L) 16 else 8
      val size = when (size32) { 0L -> (end - offset).toLong(); 1L -> bytes.getLong(offset + 8); else -> size32 }
      require(size >= header && size <= end.toLong() - offset) { "Invalid $type box size $size" }
      val payload = offset + header
      if (type in setOf("mvhd", "tkhd", "mdhd")) {
        val version = bytes.get(payload).toInt() and 0xff
        require(version == 0 || version == 1)
        val creation = if (version == 1) bytes.getLong(payload + 4) else bytes.getInt(payload + 4).toLong() and 0xffffffffL
        val modification = if (version == 1) bytes.getLong(payload + 12) else bytes.getInt(payload + 8).toLong() and 0xffffffffL
        result += type to (creation to modification)
      } else if (type in setOf("moov", "trak", "mdia")) {
        readHeaders(bytes, payload, offset + size.toInt(), result)
      }
      offset += size.toInt()
    }
  }
}
