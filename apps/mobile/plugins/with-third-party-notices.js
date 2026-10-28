// Release builds carry the third-party notices that Settings → Third-party licenses shows
// (scripts/third-party-notices.gradle and scripts/third-party-notices.mjs).
const { withAppBuildGradle } = require('expo/config-plugins');

const LINE = 'apply from: "../../scripts/third-party-notices.gradle"';

module.exports = function withThirdPartyNotices(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes(LINE)) cfg.modResults.contents += `\n${LINE}\n`;
    return cfg;
  });
};
