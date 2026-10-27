package expo.modules.corvus.qrscanner

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer

/**
 * Finds a QR code in a greyscale image, such as the luminance (Y) plane of a camera frame, with
 * ZXing, on the phone. It uses no Android classes, so it is unit-tested on the JVM with real images
 * (src/test). Not thread-safe: use one decoder per thread.
 */
class QrDecoder {
  private val reader = MultiFormatReader().apply {
    setHints(
      mapOf(
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
        // Slower per frame but finds small, tilted or blurry codes; a 720p frame still takes a few
        // tens of milliseconds.
        DecodeHintType.TRY_HARDER to true,
        // Light modules on a dark background too (a screen in dark mode).
        DecodeHintType.ALSO_INVERTED to true
      )
    )
  }

  /**
   * The text of the QR code in [luminance], or null when none is found. The image is [width] by
   * [height] pixels, one byte per pixel, [rowStride] bytes per row (at least [width]);
   * [luminance] holds at least `rowStride * height` bytes.
   */
  fun decode(luminance: ByteArray, rowStride: Int, width: Int, height: Int): String? {
    require(width > 0 && height > 0 && rowStride >= width) { "bad image size" }
    require(luminance.size >= rowStride * height) { "image data too short" }
    val source = PlanarYUVLuminanceSource(luminance, rowStride, height, 0, 0, width, height, false)
    return try {
      // The hybrid binarizer thresholds each block against its neighbourhood, so uneven light and
      // low contrast still work.
      reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
    } catch (_: ReaderException) {
      null
    } finally {
      reader.reset()
    }
  }
}
