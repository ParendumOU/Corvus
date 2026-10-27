package expo.modules.corvus.qrscanner

import java.io.InputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Decodes real QR code images (src/test/resources/qr, made by scripts/make-fixtures.mjs: pairing
 * codes as the desktop draws them, shot "through a camera") the way the app decodes camera frames: a
 * luminance plane, one byte per pixel, rows possibly padded.
 */
class QrDecoderTest {
  private data class Fixture(val file: String, val expected: String?, val note: String)

  private class Luminance(val bytes: ByteArray, val rowStride: Int, val width: Int, val height: Int)

  private val fixtures: List<Fixture> by lazy {
    resource("fixtures.tsv").bufferedReader().readLines()
      .filter { it.isNotBlank() && !it.startsWith("#") }
      .map { line ->
        val (file, expected, note) = line.split('\t')
        Fixture(file, expected.takeIf { it != "-" }, note)
      }
  }

  private fun resource(name: String): InputStream =
    requireNotNull(javaClass.classLoader?.getResourceAsStream("qr/$name")) { "missing test resource qr/$name" }

  private fun fixture(file: String) = fixtures.first { it.file == file }

  @Test
  fun decodesEveryFixture() {
    assertTrue("too few fixtures", fixtures.size >= 6)
    val decoder = QrDecoder()
    val wrong = fixtures.filter { fixture ->
      val frame = luminance(fixture.file)
      val started = System.nanoTime()
      val text = decoder.decode(frame.bytes, frame.rowStride, frame.width, frame.height)
      val ms = (System.nanoTime() - started) / 1_000_000
      val ok = text == fixture.expected
      println("${if (ok) "ok  " else "FAIL"} ${fixture.file} (${frame.width}x${frame.height}, ${fixture.note}): ${if (text == null) "no code" else "${text.length} characters"} in $ms ms")
      !ok
    }
    assertEquals("fixtures not decoded as expected", emptyList<String>(), wrong.map { it.file })
  }

  @Test
  fun readsFramesWithPaddedRows() {
    // Camera frames often have more bytes per row than pixels: the padding must be skipped.
    val photo = fixture("photo.jpg")
    val frame = luminance(photo.file, padding = 64)
    assertEquals(photo.expected, QrDecoder().decode(frame.bytes, frame.rowStride, frame.width, frame.height))
  }

  @Test
  fun oneDecoderServesFrameAfterFrame() {
    // The analyser reuses its decoder: a frame without a code must not spoil the next one.
    val decoder = QrDecoder()
    val empty = luminance("no-code.jpg")
    val rotated = fixture("rotated.jpg")
    val frame = luminance(rotated.file)
    repeat(3) {
      assertNull(decoder.decode(empty.bytes, empty.rowStride, empty.width, empty.height))
      assertEquals(rotated.expected, decoder.decode(frame.bytes, frame.rowStride, frame.width, frame.height))
    }
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsShortData() {
    QrDecoder().decode(ByteArray(10), 4, 4, 4)
  }

  /**
   * A PNG or JPEG file's luminance (BT.601, like a camera's Y plane), each row padded with
   * [padding] bytes. Read with the JDK's ImageIO through reflection: an Android module's tests are
   * compiled against android.jar, which has no java.awt or javax.imageio.
   */
  private fun luminance(file: String, padding: Int = 0): Luminance {
    val bufferedImage = Class.forName("java.awt.image.BufferedImage")
    val raster = Class.forName("java.awt.image.Raster")
    val image = resource(file).use { Class.forName("javax.imageio.ImageIO").getMethod("read", InputStream::class.java).invoke(null, it) }
      ?: error("cannot read $file")
    val width = bufferedImage.getMethod("getWidth").invoke(image) as Int
    val height = bufferedImage.getMethod("getHeight").invoke(image) as Int
    val pixels = bufferedImage.getMethod("getRaster").invoke(image)
    val colorModel = bufferedImage.getMethod("getColorModel").invoke(image)
    val grey = raster.getMethod("getNumBands").invoke(pixels) == 1 && !Class.forName("java.awt.image.IndexColorModel").isInstance(colorModel)
    val values: IntArray = if (grey) {
      // Grey images are taken as stored, scaled to 0-255 (getRGB would put them through a gamma curve).
      val sampleModel = bufferedImage.getMethod("getSampleModel").invoke(image)
      val bits = Class.forName("java.awt.image.SampleModel").getMethod("getSampleSize", Int::class.javaPrimitiveType).invoke(sampleModel, 0) as Int
      val int = Int::class.javaPrimitiveType
      val samples = raster.getMethod("getSamples", int, int, int, int, int, IntArray::class.java).invoke(pixels, 0, 0, width, height, 0, null) as IntArray
      IntArray(samples.size) { samples[it] * 255 / ((1 shl bits) - 1) }
    } else {
      val int = Int::class.javaPrimitiveType
      val rgb = bufferedImage.getMethod("getRGB", int, int, int, int, IntArray::class.java, int, int).invoke(image, 0, 0, width, height, null, 0, width) as IntArray
      IntArray(rgb.size) { (299 * ((rgb[it] shr 16) and 0xff) + 587 * ((rgb[it] shr 8) and 0xff) + 114 * (rgb[it] and 0xff)) / 1000 }
    }
    val rowStride = width + padding
    val bytes = ByteArray(rowStride * height) { 0x55 }
    for (y in 0 until height) {
      for (x in 0 until width) bytes[y * rowStride + x] = values[y * width + x].toByte()
    }
    return Luminance(bytes, rowStride, width, height)
  }
}
