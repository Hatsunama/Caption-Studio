package app.captionstudio.translation

import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.ResponseFormat
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.ThinkingConfig
import com.google.gson.JsonParser
import java.io.File
import java.util.function.BooleanSupplier
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
  ): TranslationRuntime = open(
    model, cacheDirectory, threadCount, systemInstruction,
    TranslationBackendSelection.Preference.AUTO, BooleanSupplier { false },
  )

  @Throws(Exception::class)
  override fun open(
    model: File,
    cacheDirectory: File,
    threadCount: Int,
    systemInstruction: String,
    preference: TranslationBackendSelection.Preference,
    cancelled: BooleanSupplier,
  ): TranslationRuntime {
    val conversationConfig = ConversationConfig(
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
    )
    return TranslationBackendSelection.open(preference, { selected ->
      val engine = Engine(
        EngineConfig(
          modelPath = model.absolutePath,
          backend = if (selected == "gpu") Backend.GPU() else Backend.CPU(threadCount, null),
          maxNumTokens = ENGINE_TOKEN_LIMIT,
          cacheDir = cacheDirectory.absolutePath,
        ),
      )
      object : TranslationBackendSelection.Candidate {
        override fun initialize(): TranslationRuntime {
          engine.initialize()
          return LiteRtLmTranslationRuntime(engine, conversationConfig)
        }

        override fun close() { engine.close() }
      }
    }, cancelled)
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

  override fun supportsStructuredOutput(): Boolean = true

  @Throws(Exception::class)
  override fun translate(prompt: String): String = translate(prompt, 1_536)

  @Throws(Exception::class)
  override fun translate(prompt: String, maxOutputTokens: Int): String =
    translate(prompt, maxOutputTokens, false)

  @Throws(Exception::class)
  override fun translate(prompt: String, maxOutputTokens: Int, requireStructuredOutput: Boolean): String {
    check(!closed.get()) { "The translation runtime is closed" }
    if (cancelled.get()) throw CancellationException("Caption translation was cancelled")

    require(maxOutputTokens in 1..1_536)
    val conversation = engine.createConversation(conversationConfig.copy(
      maxOutputToken = maxOutputTokens,
      enableResponseFormat = requireStructuredOutput,
    ))
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
      response = if (requireStructuredOutput) {
        val captionCount = JsonParser.parseString(prompt).asJsonObject.getAsJsonArray("captions").size()
        conversation.sendMessage(prompt, responseFormat = ResponseFormat.json(responseJsonSchema(captionCount))).toString()
      } else {
        conversation.sendMessage(prompt).toString()
      }
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

  private companion object {
    fun responseJsonSchema(count: Int): String =
      """{"type":"array","minItems":$count,"maxItems":$count,"items":{"type":"object","properties":{"id":{"type":"string"},"text":{"type":"string"}},"required":["id","text"],"additionalProperties":false}}"""
  }
}

private fun rethrow(failure: Throwable): Nothing = when (failure) {
  is Exception -> throw failure
  is Error -> throw failure
  else -> throw IllegalStateException("Unexpected LiteRT-LM failure", failure)
}
