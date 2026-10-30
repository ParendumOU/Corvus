// React Native learns that dark mode changed only when Android hands the change to the running
// activity. When Android builds the activity again instead (the font size changed as well, or it closed
// the activity in the background) while the app keeps running, the app kept its old colours. On every
// resume the activity passes its configuration to React Native, which tells the app when the colour
// scheme differs from the last one it reported.
const { withMainActivity } = require('expo/config-plugins');

const SYNC = 'reactHost?.onConfigurationChanged(this)';
const CLASS = /^class MainActivity : ReactActivity\(\) \{$/m;

function syncThemeOnResume(source) {
  if (source.includes(SYNC)) return source;
  if (/\bfun onResume\(/.test(source)) throw new Error('with-system-theme: MainActivity already overrides onResume');
  if (!CLASS.test(source)) throw new Error('with-system-theme: no MainActivity class');
  return source.replace(CLASS, (line) => `${line}\n  override fun onResume() {\n    super.onResume()\n    ${SYNC}\n  }\n`);
}

module.exports = function withSystemTheme(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') throw new Error('with-system-theme: MainActivity is not Kotlin');
    cfg.modResults.contents = syncThemeOnResume(cfg.modResults.contents);
    return cfg;
  });
};
module.exports.syncThemeOnResume = syncThemeOnResume;
