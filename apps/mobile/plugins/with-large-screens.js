// Android: no orientation lock, so the app turns with the phone and fills tablets, foldables and
// desktop windows (Google Play asks apps to drop orientation and resizability restrictions on large
// screens; Android 16 ignores them there anyway). app.json keeps "orientation": "portrait" for iOS,
// where the app runs on the iPhone only.
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withLargeScreens(config) {
  return withAndroidManifest(config, (cfg) => {
    for (const activity of cfg.modResults.manifest.application?.[0]?.activity ?? []) {
      delete activity.$['android:screenOrientation'];
      delete activity.$['android:resizeableActivity'];
    }
    return cfg;
  });
};
