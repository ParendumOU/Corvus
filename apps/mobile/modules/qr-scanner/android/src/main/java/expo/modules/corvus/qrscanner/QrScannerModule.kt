package expo.modules.corvus.qrscanner

import android.Manifest
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Corvus's QR code scanner on Android: the camera permission and a camera preview view that reports
 * the QR codes it sees (QrScannerView), decoded on the phone with ZXing (QrDecoder). No image or
 * result leaves the phone, and no Google library is involved.
 */
class QrScannerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CorvusQrScanner")

    AsyncFunction("getCameraPermissionsAsync") { promise: Promise ->
      Permissions.getPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.CAMERA)
    }

    AsyncFunction("requestCameraPermissionsAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.CAMERA)
    }

    View(QrScannerView::class) {
      Events("onCodeScanned")

      OnViewDestroys { view ->
        view.release()
      }
    }
  }
}
