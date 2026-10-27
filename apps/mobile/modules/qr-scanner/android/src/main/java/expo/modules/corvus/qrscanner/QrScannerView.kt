package expo.modules.corvus.qrscanner

import android.annotation.SuppressLint
import android.content.Context
import android.os.SystemClock
import android.util.Log
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.UseCase
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class CodeScannedEvent(@Field val data: String) : Record

/**
 * The back camera's preview. Every frame's luminance goes to [QrDecoder] on a background thread, and
 * each QR code found is sent to JavaScript as `onCodeScanned` ({ data }): the same code at most once
 * every [REPEAT_INTERVAL_MS]. The camera runs while the view is on screen and the app is in the
 * foreground (CameraX follows the activity's lifecycle).
 */
@SuppressLint("ViewConstructor")
class QrScannerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // PreviewView adds its own child view once the camera starts; React Native would not lay it out.
  override val shouldUseAndroidLayout: Boolean
    get() = true

  private val onCodeScanned by EventDispatcher<CodeScannedEvent>()

  // A TextureView, so the preview is clipped to the view's rounded corners like any other view.
  private val previewView = PreviewView(context).apply {
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }
  private val mainExecutor = ContextCompat.getMainExecutor(context)
  private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()

  // Used only on analysisExecutor.
  private val decoder = QrDecoder()
  private var frame = ByteArray(0)

  private var cameraProvider: ProcessCameraProvider? = null
  private var useCases: List<UseCase> = emptyList()
  private var released = false

  @Volatile private var lastText: String? = null
  @Volatile private var lastSentAt = 0L

  init {
    addView(previewView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    startCamera()
  }

  override fun onDetachedFromWindow() {
    stopCamera()
    super.onDetachedFromWindow()
  }

  /** The view is gone for good. */
  fun release() {
    released = true
    stopCamera()
    analysisExecutor.shutdown()
  }

  private fun startCamera() {
    if (released || useCases.isNotEmpty()) return
    val owner = appContext.currentActivity as? LifecycleOwner
    if (owner == null) {
      Log.w(TAG, "No activity to run the camera in")
      return
    }
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      if (released || !isAttachedToWindow || useCases.isNotEmpty()) return@addListener
      try {
        val provider = future.get()
        // 4:3, the sensor's shape, so the frames cover everything the preview shows; 1280x960 is
        // sharp enough for the pairing code and quick to decode.
        val selector = ResolutionSelector.Builder()
          .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
          .setResolutionStrategy(ResolutionStrategy(Size(1280, 960), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
          .build()
        val preview = Preview.Builder()
          .setResolutionSelector(ResolutionSelector.Builder().setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY).build())
          .build()
        preview.surfaceProvider = previewView.surfaceProvider
        val analysis = ImageAnalysis.Builder()
          .setResolutionSelector(selector)
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .build()
        analysis.setAnalyzer(analysisExecutor, ::analyze)
        provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        cameraProvider = provider
        useCases = listOf(preview, analysis)
      } catch (e: Exception) {
        Log.e(TAG, "Could not start the camera", e)
      }
    }, mainExecutor)
  }

  private fun stopCamera() {
    useCases.filterIsInstance<ImageAnalysis>().forEach { it.clearAnalyzer() }
    if (useCases.isNotEmpty()) cameraProvider?.unbind(*useCases.toTypedArray())
    useCases = emptyList()
  }

  private fun analyze(image: ImageProxy) {
    image.use {
      // YUV_420_888: the first plane is the luminance, one byte per pixel.
      val plane = it.planes[0]
      val rowStride = plane.rowStride
      val needed = rowStride * it.height
      if (frame.size < needed) frame = ByteArray(needed)
      val buffer = plane.buffer
      buffer.rewind()
      buffer.get(frame, 0, minOf(buffer.remaining(), needed))
      val text = decoder.decode(frame, rowStride, it.width, it.height) ?: return
      val now = SystemClock.elapsedRealtime()
      if (text == lastText && now - lastSentAt < REPEAT_INTERVAL_MS) return
      lastText = text
      lastSentAt = now
      mainExecutor.execute {
        if (!released) onCodeScanned(CodeScannedEvent(text))
      }
    }
  }

  companion object {
    private const val TAG = "CorvusQrScanner"
    private const val REPEAT_INTERVAL_MS = 2000L
  }
}
