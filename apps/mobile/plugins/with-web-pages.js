// The browser opens plain http:// sites too (the address bar marks them "Not secure"), as every
// browser does; Android blocks cleartext traffic for apps by default since API 28.
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withWebPages(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) app.$['android:usesCleartextTraffic'] = 'true';
    return cfg;
  });
};
