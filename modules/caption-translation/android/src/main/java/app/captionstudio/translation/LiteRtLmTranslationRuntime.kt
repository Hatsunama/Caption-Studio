package app.captionstudio.translation

import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.ExperimentalApi
import com.google.ai.edge.litertlm.ExperimentalFlags
import com.google.ai.edge.litertlm.ResponseFormat
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.ThinkingConfig
import java.io.File
import java.util.Collections
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

  @OptIn(ExperimentalApi::class)
  @Throws(Exception::class)
  override fun open(
    model: File,
    cacheDirectory: File,
    threadCount: Int,
    systemInstruction: String,
    preference: TranslationBackendSelection.Preference,
    cancelled: BooleanSupplier,
  ): TranslationRuntime {
    // v0.16.1 reads this instrumentation flag during engine initialization.
    ExperimentalFlags.enableBenchmark = true
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
  private val generationDiagnostics = TranslationGenerationDiagnosticsState()

  override fun supportsStructuredOutput(): Boolean = true

  override fun lastGenerationDiagnostics(): Map<String, Any> = generationDiagnostics.get()

  @Throws(Exception::class)
  override fun translate(prompt: String): String = translate(prompt, 1_536)

  @Throws(Exception::class)
  override fun translate(prompt: String, maxOutputTokens: Int): String =
    translate(prompt, maxOutputTokens, false)

  @Throws(Exception::class)
  override fun translate(prompt: String, maxOutputTokens: Int, requireStructuredOutput: Boolean): String =
    translate(prompt, maxOutputTokens, requireStructuredOutput,
      if (requireStructuredOutput) GENERIC_RESPONSE_SCHEMA else null)

  @Throws(Exception::class)
  override fun translate(
    prompt: String,
    maxOutputTokens: Int,
    requireStructuredOutput: Boolean,
    responseSchema: String?,
  ): String {
    generationDiagnostics.clear()
    check(!closed.get()) { "The translation runtime is closed" }
    if (cancelled.get()) throw CancellationException("Caption translation was cancelled")

    require(maxOutputTokens in 1..1_536)
    require(requireStructuredOutput || responseSchema == null) {
      "A response schema requires structured output"
    }
    require(!requireStructuredOutput || !responseSchema.isNullOrBlank()) {
      "Structured output requires a response schema"
    }
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
        conversation.sendMessage(prompt, responseFormat = ResponseFormat.json(checkNotNull(responseSchema))).toString()
      } else {
        conversation.sendMessage(prompt).toString()
      }
    } catch (failure: Throwable) {
      operationFailure = failure
    }

    val cleanupFailure = lifecycleLock.withLock {
      // Capture before closing; optional instrumentation must never replace a generation failure.
      val benchmark = runCatching {
        @OptIn(ExperimentalApi::class)
        conversation.getBenchmarkInfo()
      }.getOrNull()
      generationDiagnostics.set(TranslationGenerationDiagnostics.snapshot(
        benchmark != null,
        benchmark?.initTimeInSecond ?: 0.0,
        benchmark?.timeToFirstTokenInSecond ?: 0.0,
        benchmark?.lastPrefillTokenCount ?: -1,
        benchmark?.lastDecodeTokenCount ?: -1,
        benchmark?.lastPrefillTokensPerSecond ?: 0.0,
        benchmark?.lastDecodeTokensPerSecond ?: 0.0,
        maxOutputTokens, operationFailure == null,
      ))
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
    const val GENERIC_RESPONSE_SCHEMA =
      """{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"text":{"type":"string","minLength":1}},"required":["id","text"],"additionalProperties":false}}"""
  }
}

internal class TranslationGenerationDiagnosticsState {
  private val values = AtomicReference<Map<String, Any>>(emptyMap())

  fun get(): Map<String, Any> = values.get()
  fun set(snapshot: Map<String, Any>) { values.set(snapshot) }
  fun clear() { values.set(emptyMap()) }
}

internal object TranslationGenerationDiagnostics {
  @JvmStatic
  fun snapshot(
    benchmarkAvailable: Boolean,
    initTimeInSecond: Double,
    timeToFirstTokenInSecond: Double,
    prefillTokenCount: Int,
    decodeTokenCount: Int,
    prefillTokensPerSecond: Double,
    decodeTokensPerSecond: Double,
    outputTokenLimit: Int,
    succeeded: Boolean,
  ): Map<String, Any> {
    val values = linkedMapOf<String, Any>(
      "outputTokenLimit" to outputTokenLimit,
      "benchmarkAvailable" to benchmarkAvailable,
      // The SDK exposes counts and throughput, but no finish reason or EOS indication.
      "terminationReason" to "unknown",
    )
    if (benchmarkAvailable) {
      fun timing(key: String, seconds: Double) {
        val milliseconds = seconds * 1_000.0
        if (seconds >= 0.0 && milliseconds.isFinite()) values[key] = milliseconds
      }
      fun phase(name: String, count: Int, rate: Double) {
        if (count >= 0) values["${name}TokenCount"] = count
        if (rate > 0.0 && rate.isFinite()) {
          values["${name}TokensPerSecond"] = rate
          val milliseconds = count.toDouble() / rate * 1_000.0
          if (count > 0 && milliseconds.isFinite()) {
            values["${name}DurationMsFromThroughput"] = milliseconds
          }
        }
      }
      timing("initTimeMs", initTimeInSecond)
      timing("timeToFirstTokenMs", timeToFirstTokenInSecond)
      phase("prefill", prefillTokenCount, prefillTokensPerSecond)
      phase("decode", decodeTokenCount, decodeTokensPerSecond)
      val decoded = decodeTokenCount
      if (outputTokenLimit > 0 && decoded > 0 && (succeeded || decoded >= outputTokenLimit)) {
        // Observed cap saturation is evidence of a hit, not an SDK termination reason.
        values["outputTokenLimitHit"] = decoded >= outputTokenLimit
      }
    }
    return Collections.unmodifiableMap(values)
  }
}

private fun rethrow(failure: Throwable): Nothing = when (failure) {
  is Exception -> throw failure
  is Error -> throw failure
  else -> throw IllegalStateException("Unexpected LiteRT-LM failure", failure)
}
