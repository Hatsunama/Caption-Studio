package app.captionstudio.media

import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.ui.AspectRatioFrameLayout
import expo.modules.video.VideoView
import expo.modules.video.listeners.VideoPlayerListener
import expo.modules.video.player.VideoPlayer
import kotlin.math.abs

/** Combines reading-source identity, current-output rendering, and Expo's layout receipt.
 * No metadata listener, output, SDK layout state or shutter is replaced by this observer.
 */
@OptIn(UnstableApi::class)
internal class VideoFrameReceipt(
  private val player: Player,
  private val installed: MediaItem,
  private val targetMs: Long,
  private val hooks: Hooks,
  private val current: () -> Boolean,
  private val changed: () -> Unit,
) : AutoCloseable {
  internal interface Hooks {
    fun currentView(): Any?
    fun layoutValid(): Boolean
    fun addAnalytics(listener: AnalyticsListener)
    fun removeAnalytics(listener: AnalyticsListener)
    fun addSdk(listener: VideoPlayerListener)
    fun removeSdk(listener: VideoPlayerListener)
  }

  internal class NativeHooks(private val video: VideoPlayer) : Hooks {
    override fun currentView(): Any? = video.currentVideoView
    override fun layoutValid(): Boolean {
      val view = video.currentVideoView ?: return false
      if (view.playerView.player !== video.player) return false
      val surface = video.player.surfaceSize
      if (surface.width == 0 || surface.height == 0) return false
      val size = video.player.videoSize
      // Same validity rule as the installed SDK's FirstFrameEventGenerator.
      return size.width == 0 || size.height == 0 ||
        view.playerView.resizeMode == AspectRatioFrameLayout.RESIZE_MODE_FILL ||
        abs(size.width.toFloat() / size.height * size.pixelWidthHeightRatio -
          surface.width.toFloat() / surface.height) < 0.05
    }
    override fun addAnalytics(listener: AnalyticsListener) = video.player.addAnalyticsListener(listener)
    override fun removeAnalytics(listener: AnalyticsListener) = video.player.removeAnalyticsListener(listener)
    override fun addSdk(listener: VideoPlayerListener) = video.addListener(listener)
    override fun removeSdk(listener: VideoPlayerListener) = video.removeListener(listener)
  }

  private var active = true
  private var view: Any? = null
  private var sourceFrame = false
  private var outputFrame = false
  private var sdkFrame = false
  private var presentedView: Any? = null
  private fun live() = active && current()
  private fun targetCurrent() = player.currentMediaItem === installed && player.currentPosition == targetMs
  private fun resetFrame() { view = null; sourceFrame = false; outputFrame = false; sdkFrame = false }
  private fun reset() { resetFrame(); presentedView = null }
  private fun bindingCurrent() = view != null && view === hooks.currentView() && targetCurrent()
  private inline fun observe(action: () -> Unit) {
    if (!live()) return
    try { action() } catch (_: Exception) {
      reset()
      changed() // The coordinator owns released-player/error settlement and listener cleanup.
    }
  }

  private val analytics = object : AnalyticsListener {
    override fun onRenderedFirstFrame(eventTime: AnalyticsListener.EventTime, output: Any, renderTimeMs: Long) = observe {
      // Every analytics frame replaces the candidate, including a stale output's frame.
      // ExoPlayer 1.11 dispatches this synchronously BEFORE the current-output Player event.
      if (presentedView !== hooks.currentView() || !targetCurrent()) presentedView = null
      resetFrame()
      val periodId = eventTime.mediaPeriodId ?: return@observe
      val timeline = eventTime.timeline
      val index = timeline.getIndexOfPeriod(periodId.periodUid)
      if (index < 0 || !targetCurrent()) return@observe
      val period = timeline.getPeriod(index, Timeline.Period())
      if (timeline.getWindow(period.windowIndex, Timeline.Window()).mediaItem !== installed) return@observe
      view = hooks.currentView() ?: return@observe
      sourceFrame = true
    }
  }
  private val outputListener = object : Player.Listener {
    override fun onRenderedFirstFrame() = observe {
      if (!sourceFrame || !bindingCurrent()) { reset(); return@observe }
      // Media3 only emits this callback when videoOutput == the analytics event's output.
      outputFrame = true
      if (sdkFrame) presentedView = view
      changed()
    }
    override fun onSurfaceSizeChanged(width: Int, height: Int) = observe {
      if (!bindingCurrent()) reset()
      changed()
    }
    override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) = observe {
      reset()
    }
  }
  private val sdk = object : VideoPlayerListener {
    override fun onTargetViewChanged(player: VideoPlayer, newTargetView: VideoView?, oldTargetView: VideoView?) = observe {
      // MutableWeakReference invokes didSet(old,new). Never trust the argument labels.
      reset()
      changed()
    }
    override fun onRenderedFirstFrame(player: VideoPlayer) = observe {
      if (!sourceFrame || !bindingCurrent() || !hooks.layoutValid()) return@observe
      sdkFrame = true
      if (outputFrame) presentedView = view
      changed()
    }
  }

  init {
    try {
      hooks.addAnalytics(analytics)
      player.addListener(outputListener)
      hooks.addSdk(sdk)
    } catch (failure: Exception) { close(); throw failure }
  }

  // Expo emits once per item/view, even if Media3 renders another first frame after a resize.
  // Retain only an SDK receipt already paired with a source-specific current-output frame.
  fun isPresented(): Boolean = live() && sourceFrame && outputFrame && presentedView === view &&
    bindingCurrent() && hooks.layoutValid()

  override fun close() {
    if (!active) return
    active = false // Guard snapshots already taken by the SDK/Media3 before removal.
    reset()
    runCatching { hooks.removeAnalytics(analytics) }
    runCatching { player.removeListener(outputListener) }
    runCatching { hooks.removeSdk(sdk) }
  }
}
