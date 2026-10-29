// Android 12+ shows the splash screen in a window of its own. expo-splash-screen asks Android to hand
// it over to the app (an exit animation listener); on a phone busy at start-up the hand-over can come
// after Android stopped waiting for it (2 s) and began its own exit animation, which slides the app's
// window up 20 dp into place. The late hand-over cuts that animation short and Android leaves the
// whole app lower, with a black band across the top, until the app is closed. Without the listener
// Android plays its own exit animation to the end. The splash still stays until the app hides it.
const { withMainActivity } = require('expo/config-plugins');

const CLEAR = 'if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) splashScreen.clearOnExitAnimationListener()';
const ON_CREATE = /^([ \t]*)super\.onCreate\(null\)$/m;

function clearSplashExit(source) {
  if (source.includes(CLEAR)) return source;
  if (!ON_CREATE.test(source)) throw new Error('with-splash-exit: no super.onCreate(null) in MainActivity');
  const out = source.replace(ON_CREATE, (line, indent) => `${line}\n${indent}${CLEAR}`);
  return /^import android\.os\.Build$/m.test(out) ? out : out.replace(/^(package .*)$/m, '$1\n\nimport android.os.Build');
}

module.exports = function withSplashExit(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') throw new Error('with-splash-exit: MainActivity is not Kotlin');
    cfg.modResults.contents = clearSplashExit(cfg.modResults.contents);
    return cfg;
  });
};
module.exports.clearSplashExit = clearSplashExit;
