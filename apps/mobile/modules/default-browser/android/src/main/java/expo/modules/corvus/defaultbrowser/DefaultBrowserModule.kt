package expo.modules.corvus.defaultbrowser

import android.app.Activity
import android.app.role.RoleManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Request code of the system's "Set as default browser" dialog. */
private const val REQUEST_BROWSER_ROLE = 0xC0B

/**
 * A web address with no host, as Android itself looks for browser apps (its browser role): only an
 * app that handles every address matches it, not one that opens links to its own sites.
 */
private val ANY_WEB_PAGE: Uri = Uri.fromParts("http", "", null)

private class BrowserNotFoundException(packageName: String, cause: Throwable) :
  CodedException("ERR_BROWSER_NOT_FOUND", "No browser app $packageName to open the page in", cause)

private class NoActivityException :
  CodedException("ERR_NO_ACTIVITY", "Corvus is not in the foreground", null)

/**
 * Corvus as the phone's default browser: whether it is, the system dialog that makes it so (or the
 * Default apps settings where that dialog does not exist), the other browser apps, and opening a
 * page in one of them by its package, so the page never comes back to Corvus.
 */
class DefaultBrowserModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  /** The open "Set as default browser" request, answered when the dialog closes. */
  private var pendingRequest: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("CorvusDefaultBrowser")

    AsyncFunction<Bundle>("getStatusAsync") {
      Bundle().apply {
        putBoolean("isDefault", isDefault())
        putBoolean("roleAvailable", roleManager() != null)
        putString("systemDefault", systemDefaultPackage())
      }
    }

    AsyncFunction<List<Bundle>>("getBrowsersAsync") {
      browsers().map { (packageName, label) ->
        Bundle().apply {
          putString("packageName", packageName)
          putString("label", label)
        }
      }
    }

    // Resolves "granted", "dismissed", "settings" (the Default apps screen opened instead) or
    // "unavailable".
    AsyncFunction("requestDefaultAsync") { promise: Promise ->
      if (isDefault()) {
        promise.resolve("granted")
        return@AsyncFunction
      }
      val activity = appContext.currentActivity
      val roles = roleManager()
      if (activity != null && roles != null) {
        pendingRequest?.resolve("dismissed")
        pendingRequest = promise
        try {
          activity.startActivityForResult(roles.createRequestRoleIntent(RoleManager.ROLE_BROWSER), REQUEST_BROWSER_ROLE)
        } catch (err: ActivityNotFoundException) {
          pendingRequest = null
          promise.resolve(if (openDefaultAppsSettings()) "settings" else "unavailable")
        }
        return@AsyncFunction
      }
      promise.resolve(if (openDefaultAppsSettings()) "settings" else "unavailable")
    }.runOnQueue(Queues.MAIN)

    AsyncFunction<Boolean>("openDefaultAppsSettingsAsync") {
      openDefaultAppsSettings()
    }.runOnQueue(Queues.MAIN)

    // Opens a page in the given browser app. With `leave`, Corvus then steps back, so that going
    // back from the browser returns to the app the link came from.
    AsyncFunction("openUrlAsync") { url: String, packageName: String, leave: Boolean ->
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        .addCategory(Intent.CATEGORY_BROWSABLE)
        .setPackage(packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      val activity = appContext.currentActivity
      try {
        (activity ?: context).startActivity(intent)
      } catch (err: ActivityNotFoundException) {
        throw BrowserNotFoundException(packageName, err)
      }
      if (leave) activity?.moveTaskToBack(true)
      true
    }.runOnQueue(Queues.MAIN)

    // Steps back to the app Corvus was opened from (after saving or sending a link it was asked to open).
    AsyncFunction<Boolean>("leaveAsync") {
      val activity = appContext.currentActivity ?: throw NoActivityException()
      activity.moveTaskToBack(true)
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, payload ->
      if (payload.requestCode != REQUEST_BROWSER_ROLE) return@OnActivityResult
      val promise = pendingRequest ?: return@OnActivityResult
      pendingRequest = null
      promise.resolve(if (payload.resultCode == Activity.RESULT_OK || isDefault()) "granted" else "dismissed")
    }
  }

  /** The browser role's manager, where the system has the role (Android 10 and later). */
  private fun roleManager(): RoleManager? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
    val roles = context.getSystemService(RoleManager::class.java) ?: return null
    return roles.takeIf { it.isRoleAvailable(RoleManager.ROLE_BROWSER) }
  }

  private fun isDefault(): Boolean {
    val roles = roleManager()
    return if (roles != null) roles.isRoleHeld(RoleManager.ROLE_BROWSER) else systemDefaultPackage() == context.packageName
  }

  private fun webIntent(): Intent = Intent(Intent.ACTION_VIEW, ANY_WEB_PAGE).addCategory(Intent.CATEGORY_BROWSABLE)

  /** The app that opens web pages now (Corvus itself included), or null when the system asks each time. */
  private fun systemDefaultPackage(): String? {
    val pm = context.packageManager
    val info: ResolveInfo? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      pm.resolveActivity(webIntent(), PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_DEFAULT_ONLY.toLong()))
    } else {
      @Suppress("DEPRECATION")
      pm.resolveActivity(webIntent(), PackageManager.MATCH_DEFAULT_ONLY)
    }
    val activity = info?.activityInfo ?: return null
    // With no default, the system's chooser ("android", ResolverActivity) answers.
    if (activity.packageName == "android" || activity.name.endsWith("ResolverActivity")) return null
    return activity.packageName
  }

  /** Every browser app but Corvus: package and name. */
  private fun browsers(): List<Pair<String, String>> {
    val pm = context.packageManager
    // MATCH_ALL: without it Android answers a web link with the default browser alone.
    val flags = PackageManager.MATCH_ALL or PackageManager.MATCH_DEFAULT_ONLY
    val found: List<ResolveInfo> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      pm.queryIntentActivities(webIntent(), PackageManager.ResolveInfoFlags.of(flags.toLong()))
    } else {
      @Suppress("DEPRECATION")
      pm.queryIntentActivities(webIntent(), flags)
    }
    return found
      .mapNotNull { it.activityInfo }
      .filter { it.packageName != context.packageName }
      .distinctBy { it.packageName }
      .map { it.packageName to it.applicationInfo.loadLabel(pm).toString() }
  }

  /** The system's Default apps screen, where the browser app is chosen. */
  private fun openDefaultAppsSettings(): Boolean {
    val activity = appContext.currentActivity
    val intents = listOf(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS), Intent(Settings.ACTION_SETTINGS))
    for (intent in intents) {
      try {
        if (activity != null) activity.startActivity(intent) else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return true
      } catch (err: ActivityNotFoundException) {
        // Try the next one.
      }
    }
    return false
  }
}
