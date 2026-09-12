package app.captionstudio.translation

import android.content.Context
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CaptionTranslationModule : Module() {
  private val lifecycleLock = Any()

  @Volatile
  private var destroyed = false

  private var translator: NaturalCaptionTranslator? = null

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("CaptionTranslation")

    Constants(
      "limits" to mapOf(
        "maxCaptionsPerBatch" to NaturalCaptionTranslator.MAX_CAPTIONS,
        "maxOperationsPerSession" to NaturalCaptionTranslator.MAX_OPERATIONS,
        "maxBatchesPerSession" to NaturalCaptionTranslator.MAX_BATCHES,
        "maxCaptionsPerSession" to NaturalCaptionTranslator.MAX_SESSION_CAPTIONS,
        "maxCharactersPerCaption" to NaturalCaptionTranslator.MAX_CAPTION_CHARACTERS,
        "maxCaptionCharactersPerBatch" to NaturalCaptionTranslator.MAX_TOTAL_CAPTION_CHARACTERS,
        "maxCaptionCharactersPerSession" to NaturalCaptionTranslator.MAX_SESSION_CAPTION_CHARACTERS,
      ),
    )

    AsyncFunction("translateNaturalCaptions") { modelFile: String, request: Map<String, Any?>, promise: Promise ->
      val activeTranslator = synchronized(lifecycleLock) {
        if (destroyed) null
        else translator ?: NaturalCaptionTranslator(context.applicationContext).also { translator = it }
      }
      if (activeTranslator == null) {
        promise.reject(
          "E_TRANSLATION_RELEASED",
          "The local translation runtime has been released.",
          null,
        )
      } else {
        activeTranslator.start(
          modelFile,
          request,
          object : NaturalCaptionTranslator.Callback {
            override fun onSuccess(result: Map<String, Any?>) {
              promise.resolve(result)
            }

            override fun onError(code: String, message: String, cause: Throwable?) {
              promise.reject(code, message, cause)
            }
          },
        )
      }
    }

    AsyncFunction("cancelNaturalCaptionTranslation") {
      synchronized(lifecycleLock) { translator }?.cancel()
    }

    AsyncFunction("getNaturalCaptionTranslationProgress") {
      val activeTranslator = synchronized(lifecycleLock) { translator }
      if (activeTranslator != null) activeTranslator.progress
      else NaturalCaptionTranslator.idleProgress()
    }

    OnDestroy {
      val activeTranslator = synchronized(lifecycleLock) {
        destroyed = true
        val currentTranslator = translator
        translator = null
        currentTranslator
      }
      activeTranslator?.close()
    }
  }
}
