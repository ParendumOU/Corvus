// Release builds are shrunk, optimized and obfuscated with R8, resources included (the generated
// project's android.enableShrinkResourcesInReleaseBuilds; Google Play asks for it). Adds
// plugins/proguard-rules.pro to the keep rules of the generated project, and
// plugins/keep-resources.xml for the resources looked up by name (see "R8" in docs/MOBILE.md).
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withGradleProperties } = require('expo/config-plugins');

const MARKER = '# Corvus: plugins/proguard-rules.pro';
const SHRINK_RESOURCES = 'android.enableShrinkResourcesInReleaseBuilds';

module.exports = function withR8Rules(config) {
  config = withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter((item) => !(item.type === 'property' && item.key === SHRINK_RESOURCES));
    cfg.modResults.push({ type: 'property', key: SHRINK_RESOURCES, value: 'true' });
    return cfg;
  });
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const app = path.join(cfg.modRequest.platformProjectRoot, 'app');
      const target = path.join(app, 'proguard-rules.pro');
      const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      if (!current.includes(MARKER)) {
        const rules = fs.readFileSync(path.join(__dirname, 'proguard-rules.pro'), 'utf8');
        fs.writeFileSync(target, `${current.trimEnd()}\n\n${MARKER}\n${rules}`);
      }
      const raw = path.join(app, 'src', 'main', 'res', 'raw');
      fs.mkdirSync(raw, { recursive: true });
      fs.copyFileSync(path.join(__dirname, 'keep-resources.xml'), path.join(raw, 'corvus_keep.xml'));
      return cfg;
    },
  ]);
};
