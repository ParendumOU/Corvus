// When Android builds the activity again from its saved state (the app ended in the background to free
// memory, or a configuration change the activity does not take in place), it hands it the intent that
// first opened it: the app would open that link, share or notification again and start over on Home.
// The activity then starts with corvus://restore instead, which the app turns into the screen the
// person was on (src/app/+native-intent.ts). A new intent still arrives through onNewIntent.
const { withMainActivity } = require('expo/config-plugins');

const RESTORE = 'if (savedInstanceState != null) intent = Intent(Intent.ACTION_VIEW, Uri.parse("corvus://restore"))';
const ON_CREATE = /^([ \t]*)super\.onCreate\(null\)$/m;
const IMPORTS = ['android.content.Intent', 'android.net.Uri'];

function restoreLinkOnRebuild(source) {
  if (source.includes(RESTORE)) return source;
  if (!ON_CREATE.test(source)) throw new Error('with-restore-link: no super.onCreate(null) in MainActivity');
  let out = source.replace(ON_CREATE, (line, indent) => `${indent}${RESTORE}\n${line}`);
  for (const name of IMPORTS) {
    if (!new RegExp(`^import ${name.replace(/\./g, '\\.')}$`, 'm').test(out)) out = out.replace(/^(package .*)$/m, `$1\n\nimport ${name}`);
  }
  return out;
}

module.exports = function withRestoreLink(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') throw new Error('with-restore-link: MainActivity is not Kotlin');
    cfg.modResults.contents = restoreLinkOnRebuild(cfg.modResults.contents);
    return cfg;
  });
};
module.exports.restoreLinkOnRebuild = restoreLinkOnRebuild;
