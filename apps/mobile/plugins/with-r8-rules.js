// Release builds are shrunk and obfuscated with R8: adds plugins/proguard-rules.pro to the keep
// rules of the generated project (see "R8" in docs/MOBILE.md).
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod } = require('expo/config-plugins');

const MARKER = '# Corvus: plugins/proguard-rules.pro';

module.exports = function withR8Rules(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const target = path.join(cfg.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro');
      const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      if (!current.includes(MARKER)) {
        const rules = fs.readFileSync(path.join(__dirname, 'proguard-rules.pro'), 'utf8');
        fs.writeFileSync(target, `${current.trimEnd()}\n\n${MARKER}\n${rules}`);
      }
      return cfg;
    },
  ]);
};
