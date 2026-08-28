package app.captionstudio.diagnostics

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CaptionDiagnosticsModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("CaptionDiagnostics")

    AsyncFunction("getHistoricalExitReasons") { requestedLimit: Int ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return@AsyncFunction emptyList<Map<String, Any>>()
      val limit = requestedLimit.coerceIn(1, MAX_EXIT_RECORDS)
      val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val versionCode = context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode
      activityManager.getHistoricalProcessExitReasons(context.packageName, 0, limit).map { exit ->
        mapOf(
          "timestampMs" to exit.timestamp.toDouble(),
          "reason" to exit.reason,
          "status" to exit.status,
          "importance" to exit.importance,
          "pssKb" to exit.pss.toDouble(),
          "rssKb" to exit.rss.toDouble(),
          "description" to safeReasonDescription(exit.reason),
          "versionCode" to versionCode.toDouble(),
        )
      }
    }
  }

  private fun safeReasonDescription(reason: Int): String = when (reason) {
    ApplicationExitInfo.REASON_EXIT_SELF -> "App requested exit"
    ApplicationExitInfo.REASON_SIGNALED -> "Native signal"
    ApplicationExitInfo.REASON_LOW_MEMORY -> "System low memory"
    ApplicationExitInfo.REASON_CRASH -> "Java or Kotlin crash"
    ApplicationExitInfo.REASON_CRASH_NATIVE -> "Native crash"
    ApplicationExitInfo.REASON_ANR -> "App not responding"
    ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "Startup failure"
    ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "Permission change"
    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "Excessive resource use"
    ApplicationExitInfo.REASON_USER_REQUESTED -> "User or system stopped app"
    ApplicationExitInfo.REASON_USER_STOPPED -> "User stopped app"
    ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "Dependency stopped"
    ApplicationExitInfo.REASON_OTHER -> "Other system exit"
    else -> "Unknown system exit"
  }

  private companion object {
    const val MAX_EXIT_RECORDS = 32
  }
}
