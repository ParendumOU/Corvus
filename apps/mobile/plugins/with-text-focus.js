// Selectable text (a chat message, an answer, a licence) can take the focus a text field gives up: a
// sent question opens its chat and the message box goes away, so Android focuses the question's
// bubble. Out of touch mode (a hardware keyboard, key events from adb) Android then draws its default
// focus highlight, a grey box over the text. Text needs no focus mark of its own (TalkBack draws its
// own, selecting still works), so the app's text views go without it.
const { withAndroidStyles } = require('expo/config-plugins');

const TEXT_STYLE = 'CorvusTextView';

module.exports = function withTextFocus(config) {
  return withAndroidStyles(config, (cfg) => {
    const styles = (cfg.modResults.resources.style ??= []);
    const theme = styles.find((style) => style.$.name === 'AppTheme');
    if (!theme) throw new Error('with-text-focus: no AppTheme in styles.xml');
    theme.item = (theme.item ?? []).filter((item) => item.$.name !== 'android:textViewStyle');
    theme.item.push({ $: { name: 'android:textViewStyle' }, _: `@style/${TEXT_STYLE}` });
    if (!styles.some((style) => style.$.name === TEXT_STYLE)) {
      styles.push({
        $: { name: TEXT_STYLE, parent: '@android:style/Widget.Material.TextView' },
        item: [{ $: { name: 'android:defaultFocusHighlightEnabled', 'tools:targetApi': '26' }, _: 'false' }],
      });
    }
    return cfg;
  });
};
