# The browser's iOS side (see modules/browser-kit/index.ts): cookie banners answered with DuckDuckGo
# Autoconsent in a WKContentWorld of their own, on top of react-native-webview's WKWebView (through
# the notification patches/react-native-webview@14.0.1.patch adds).
#
# The banner script, Autoconsent's snippets and the packed rules are built from the npm packages by
# scripts/consent-assets.mjs, run here at pod install, so they always match the installed packages.
mobile = File.expand_path('../../..', __dir__)
generated = File.join(__dir__, 'generated')
unless system('node', File.join(mobile, 'scripts', 'consent-assets.mjs'), generated, '--ios', chdir: mobile)
  raise 'scripts/consent-assets.mjs failed: the cookie banner assets are missing'
end

Pod::Spec.new do |s|
  s.name           = 'CorvusBrowserKit'
  s.version        = '1.0.0'
  s.summary        = "Corvus's browser on iOS: cookie banners"
  s.description    = s.summary
  s.license        = 'MPL-2.0'
  s.author         = 'Parendum'
  s.homepage       = 'https://corvus.parendum.com'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift'
  s.resource_bundles = { 'CorvusConsent' => ['generated/assets/corvus-consent/*'] }
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
