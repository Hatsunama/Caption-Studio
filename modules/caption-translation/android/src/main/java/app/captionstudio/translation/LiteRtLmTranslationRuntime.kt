package app.captionstudio.translation

import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.ThinkingConfig
import java.io.File
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

internal class LiteRtLmTranslationRuntimeFactory : TranslationRuntimeFactory {
  @Throws(Exception::class)
  override fun open(
    model: File,
    cacheDirectory: File,
    threadCount: Int,
    systemInstruction: String,
  ): TranslationRuntime {
    val engine = Engine(
      EngineConfig(
        modelPath = model.absolutePath,
        backend = Backend.CPU(threadCount, null),
        maxNumTokens = ENGINE_TOKEN_LIMIT,
        cacheDir = cacheDirectory.absolutePath,
      ),
    )

    try {
      engine.initialize()
      return LiteRtLmTranslationRuntime(
        engine,
        ConversationConfig(
          Contents.of(systemInstruction),
          emptyList(),
          emptyList(),
          SamplerConfig(1, 1.0, 0.0, 0),
          false,
          emptyList(),
          emptyMap(),
          null,
          false,
          OUTPUT_TOKEN_LIMIT,
          ThinkingConfig(false, -1),
          false,
        ),
      )
    } catch (failure: Throwable) {
      val cleanupFailure = closeEngine(engine)
      if (cleanupFailure != null) {
        cleanupFailure.addSuppressed(failure)
        throw TranslationRuntimeCleanupException(
          "LiteRT-LM initialization cleanup failed",
          cleanupFailure,
        )
      }
      rethrow(failure)
    }
  }

  private fun closeEngine(engine: Engine): Throwable? {
    return runCatching { engine.close() }.exceptionOrNull()
  }

  private companion object {
    const val ENGINE_TOKEN_LIMIT = 4_096
    const val OUTPUT_TOKEN_LIMIT = 1_536
  }
}

internal class LiteRtLmTranslationRuntime(
  private val engine: Engine,
  private val conversationConfig: ConversationConfig,
) : TranslationRuntime {
  private val lifecycleLock = ReentrantLock()
  private val currentConversation = AtomicReference<Conversation?>()
  private val cancelled = AtomicBoolean(false)
  private val closed = AtomicBoolean(false)

  @Throws(Exception::class)
  override fun translate(prompt: String): String {
    check(!closed.get()) { "The translation runtime is closed" }
    if (cancelled.get()) throw CancellationException("Caption translation was cancelled")

    val conversation = engine.createConversation(conversationConfig)
    lifecycleLock.withLock {
      if (closed.get() || cancelled.get()) {
        val cleanupFailure = closeConversation(conversation)
        if (cleanupFailure != null) {
          throw TranslationRuntimeCleanupException(
            "LiteRT-LM conversation cleanup failed",
            cleanupFailure,
          )
        }
        if (cancelled.get()) {
          throw CancellationException("Caption translation was cancelled")
        }
        error("The translation runtime is closed")
      }
      currentConversation.set(conversation)
    }

    var response: String? = null
    var operationFailure: Throwable? = null
    try {
      response = conversation.sendMessage(prompt).toString()
    } catch (failure: Throwable) {
      operationFailure = failure
    }

    val cleanupFailure = lifecycleLock.withLock {
      currentConversation.compareAndSet(conversation, null)
      closeConversation(conversation)
    }
    if (cleanupFailure != null) {
      operationFailure?.let(cleanupFailure::addSuppressed)
      throw TranslationRuntimeCleanupException(
        "LiteRT-LM conversation cleanup failed",
        cleanupFailure,
      )
    }
    operationFailure?.let(::rethrow)
    return checkNotNull(response)
  }

  override fun cancel() {
    cancelled.set(true)
    if (!lifecycleLock.tryLock()) return
    try {
      currentConversation.get()?.cancelProcess()
    } finally {
      lifecycleLock.unlock()
    }
  }

  @Throws(TranslationRuntimeCleanupException::class)
  override fun close() {
    if (!closed.compareAndSet(false, true)) return
    cancelled.set(true)
    var failure: Throwable? = null
    lifecycleLock.withLock {
      currentConversation.getAndSet(null)?.let { failure = closeConversation(it) }
      if (engine.isInitialized()) {
        try {
          engine.close()
        } catch (caught: Throwable) {
          failure?.addSuppressed(caught) ?: run { failure = caught }
        }
      }
    }
    failure?.let {
      throw TranslationRuntimeCleanupException("LiteRT-LM runtime cleanup failed", it)
    }
  }

  private fun closeConversation(conversation: Conversation): Throwable? =
    runCatching { conversation.close() }.exceptionOrNull()
}

private fun rethrow(failure: Throwable): Nothing = when (failure) {
  is Exception -> throw failure
  is Error -> throw failure
  else -> throw IllegalStateException("Unexpected LiteRT-LM failure", failure)
}
