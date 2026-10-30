// Toolbar button (and its Alt+Shift+U shortcut): toggle the panel on a
// Whatnot tab, or open Whatnot with the panel showing from any other tab.
const ext = globalThis.browser || globalThis.chrome;
const WHATNOT_URL = 'https://www.whatnot.com/';

ext.action.onClicked.addListener(async (tab) => {
  try {
    await ext.tabs.sendMessage(tab.id, { type: 'wum:toggle' });
  } catch {
    // No content script answered: not a Whatnot tab, or one that was open
    // before the add-on was installed. Open Whatnot and, once its content
    // script is listening, ask it to show the panel.
    const opened = await ext.tabs.create({ url: WHATNOT_URL, index: tab.index + 1 });
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await ext.tabs.sendMessage(opened.id, { type: 'wum:open' });
        return;
      } catch {
        // Page still loading; try again.
      }
    }
  }
});
