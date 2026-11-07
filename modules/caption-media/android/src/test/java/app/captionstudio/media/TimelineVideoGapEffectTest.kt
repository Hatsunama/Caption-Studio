package app.captionstudio.media

import androidx.media3.common.C
import androidx.media3.common.GlObjectsProvider
import androidx.media3.common.GlTextureInfo
import androidx.media3.common.VideoFrameProcessingException
import androidx.media3.common.util.GlUtil
import androidx.media3.effect.GlShaderProgram
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import java.lang.reflect.Proxy
import java.util.concurrent.Executor

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE, shadows = [TimelineVideoGapEffectTest.NoGlResources::class])
class TimelineVideoGapEffectTest {
  @Implements(GlUtil::class)
  class NoGlResources {
    companion object {
      @JvmStatic @Implementation fun generateTexture(): Int { throw AssertionError("Allocated a gap texture") }
      @JvmStatic @Implementation fun createFboForTexture(id: Int): Int { throw AssertionError("Allocated a gap FBO for $id") }
      @JvmStatic @Implementation fun deleteTexture(id: Int) { throw AssertionError("Deleted producer texture $id") }
      @JvmStatic @Implementation fun deleteFbo(id: Int) { throw AssertionError("Deleted producer FBO $id") }
      @JvmStatic @Implementation fun deleteRbo(id: Int) { throw AssertionError("Deleted producer RBO $id") }
    }
  }

  private fun texture(id: Int) = GlTextureInfo(id, id + 100, id + 200, 32, 32)
  private fun provider() = Proxy.newProxyInstance(
    GlObjectsProvider::class.java.classLoader, arrayOf(GlObjectsProvider::class.java),
  ) { _, method, _ -> throw AssertionError("Gap allocated/accessed GL resources: ${method.name}") } as GlObjectsProvider

  @Test
  fun allFramesDroppedAndReturnedOnceIncludingAcrossEosFlushAndRelease() {
    val effect = TimelineVideoGapEffect()
    assertFalse(effect.isNoOp(32, 32))
    val program = effect.toGlShaderProgram(RuntimeEnvironment.getApplication(), false)
    val events = mutableListOf<String>()
    val returned = mutableListOf<GlTextureInfo>()
    val textures = (1..16).map(::texture)
    var capacity = 0
    var ended = 0
    program.setInputListener(object : GlShaderProgram.InputListener {
      override fun onReadyToAcceptInputFrame() { capacity++; events += "ready" }
      override fun onInputFrameProcessed(texture: GlTextureInfo) {
        returned += texture
        events += "processed"
      }
      override fun onFlush() { capacity = 0; events += "flush" }
    })
    program.setOutputListener(object : GlShaderProgram.OutputListener {
      override fun onOutputFrameAvailable(texture: GlTextureInfo, pts: Long) {
        throw AssertionError("A gap must not produce any output textures")
      }
      override fun onCurrentOutputStreamEnded() { ended++ }
    })
    program.setErrorListener(Executor { it.run() }) { throw AssertionError(it) }
    val provider = provider()
    fun queue(texture: GlTextureInfo, pts: Long) {
      assertEquals(1, capacity)
      capacity--
      program.queueInputFrame(provider, texture, pts)
      assertEquals(1, capacity)
      assertEquals(listOf("processed", "ready"), events.takeLast(2))
    }
    // Empty stream EOS as well as an entire image item with no outputs.
    program.signalEndOfCurrentInputStream()
    textures.take(12).forEachIndexed { index, texture -> queue(texture, 6_385_000L + index * 41_667L) }
    program.signalEndOfCurrentInputStream()
    assertEquals(2, ended)
    program.flush()
    assertEquals(listOf("flush", "ready"), events.takeLast(2))
    assertEquals(1, capacity)
    textures.drop(12).forEachIndexed { index, texture -> queue(texture, index * 41_667L) }
    program.signalEndOfCurrentInputStream()
    assertEquals(3, ended)
    program.release()
    program.release()
    assertEquals(textures.size, returned.size)
    textures.zip(returned).forEach { (expected, actual) -> assertSame(expected, actual) }
  }

  @Test
  fun callbackFailureUsesConfiguredErrorExecutorWithoutReturningTextureTwice() {
    val program = TimelineVideoGapEffect().toGlShaderProgram(RuntimeEnvironment.getApplication(), false)
    val texture = texture(20)
    val pendingErrors = mutableListOf<Runnable>()
    val errors = mutableListOf<VideoFrameProcessingException>()
    val failure = IllegalStateException("producer callback failed")
    var returns = 0
    var readiness = 0
    program.setInputListener(object : GlShaderProgram.InputListener {
      override fun onReadyToAcceptInputFrame() { readiness++ }
      override fun onInputFrameProcessed(input: GlTextureInfo) {
        assertSame(texture, input)
        returns++
        throw failure
      }
    })
    program.setErrorListener(Executor { pendingErrors += it }) { errors += it }
    program.queueInputFrame(provider(), texture, 6_385_000)
    assertEquals(1, returns)
    assertEquals(1, readiness)
    assertTrue(errors.isEmpty())
    pendingErrors.single().run()
    assertSame(failure, errors.single().cause)
    program.release()
    assertEquals(1, returns)
  }

  @Test
  fun failureAfterTextureReturnDoesNotRetryReturnOnRelease() {
    val program = TimelineVideoGapEffect().toGlShaderProgram(RuntimeEnvironment.getApplication(), true)
    val texture = texture(30)
    var ready = 0
    var returned = 0
    var errors = 0
    program.setInputListener(object : GlShaderProgram.InputListener {
      override fun onReadyToAcceptInputFrame() {
        ready++
        if (ready == 2) throw IllegalStateException("capacity callback failed")
      }
      override fun onInputFrameProcessed(input: GlTextureInfo) { assertSame(texture, input); returned++ }
    })
    program.setErrorListener(Executor { it.run() }) { errors++ }
    program.queueInputFrame(provider(), texture, 0)
    assertEquals(1, returned)
    assertEquals(1, errors)
    // Media3 requires release after an error; nothing remains owned by the filter.
    program.release()
    assertEquals(1, returned)
  }
}
