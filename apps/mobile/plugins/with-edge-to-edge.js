// Android 15 draws every app edge to edge and ignores the status and navigation bar colours; Google
// Play reports apps that still set them. React Native makes both bars see-through itself at start-up
// (edgeToEdgeEnabled), so the theme the Expo template generates does not need to set them.
const { withAndroidStyles } = require('expo/config-plugins');

const DEPRECATED = new Set(['android:statusBarColor', 'android:navigationBarColor', 'android:navigationBarDividerColor', 'android:windowLayoutInDisplayCutoutMode']);

module.exports = function withEdgeToEdge(config) {
  return withAndroidStyles(config, (cfg) => {
    for (const style of cfg.modResults.resources.style ?? []) {
      style.item = (style.item ?? []).filter((item) => !DEPRECATED.has(item.$.name));
    }
    return cfg;
  });
};
