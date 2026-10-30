// Persistent state, kept in the add-on's storage (storage.local):
//   keep     { [key]: entry }  accounts that are never unfollowed (the keep list)
//   settings { speed, showLauncher }
//   lastRun  { startedAt, accounts: [entry] }  what the last bulk unfollow
//            removed, so it can be undone
//
// A keep-list entry is { key, id?, username, displayName?, imageUrl?, addedAt }.
// Its key is the account number from WUM.userKey(id), or "@username" for an
// entry imported by name only; attachIds() swaps those for numbered keys once
// the account turns up in the Following list, so later renames don't matter.
//
// storage.local survives browser restarts and add-on reloads, and belongs to
// the add-on ID in the manifest. It is cleared only when the add-on is
// removed, which is what Export and Import on the Keep list tab are for.
(() => {
  'use strict';
  const WUM = globalThis.WUM;
  const { storage } = WUM.ext;

  const DEFAULT_SETTINGS = { speed: 'normal', showLauncher: true };
  const EXPORT_FORMAT = 'whatnot-unfollow-manager/keep-list';

  const state = { keep: {}, settings: { ...DEFAULT_SETTINGS }, lastRun: null };
  const listeners = new Set();

  const nameKey = (username) => '@' + String(username || '').toLowerCase();

  function entryFor(user, previous) {
    return {
      key: WUM.userKey(user.id),
      id: user.id,
      username: user.username,
      displayName: user.displayName || '',
      imageUrl: (user.profileImage && user.profileImage.url) || user.imageUrl || (previous && previous.imageUrl) || '',
      addedAt: (previous && previous.addedAt) || Date.now(),
    };
  }

  // While this tab has keep-list writes in flight, its memory is newer than
  // the change events still arriving for its earlier writes.
  let keepWrites = 0;
  function saveKeep() {
    keepWrites++;
    return storage.local.set({ keep: state.keep }).finally(() => keepWrites--);
  }

  // Changes made in any Whatnot tab (this one included) land here.
  storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.keep && !keepWrites) state.keep = changes.keep.newValue || {};
    if (changes.settings) state.settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    if (changes.lastRun) state.lastRun = changes.lastRun.newValue || null;
    listeners.forEach((fn) => fn(changes));
  });

  WUM.store = {
    get settings() {
      return state.settings;
    },
    get lastRun() {
      return state.lastRun;
    },

    async load() {
      const got = await storage.local.get(['keep', 'settings', 'lastRun']);
      state.keep = got.keep || {};
      state.settings = { ...DEFAULT_SETTINGS, ...got.settings };
      state.lastRun = got.lastRun || null;
    },

    subscribe(fn) {
      listeners.add(fn);
    },

    isKept(user) {
      return Boolean(state.keep[WUM.userKey(user.id)] || (user.username && state.keep[nameKey(user.username)]));
    },

    keepEntries() {
      return Object.values(state.keep);
    },

    // Mark accounts as kept or not. Updates memory right away (so the UI can
    // redraw) and resolves once the change is saved.
    setKept(users, kept) {
      for (const user of users) {
        const key = WUM.userKey(user.id);
        if (kept) state.keep[key] = entryFor(user, state.keep[key]);
        else delete state.keep[key];
        if (user.username) delete state.keep[nameKey(user.username)];
      }
      return saveKeep();
    },

    removeEntry(key) {
      delete state.keep[key];
      return saveKeep();
    },

    // Called with the freshly loaded Following list: gives name-only entries
    // their account number, and refreshes names and pictures that changed.
    attachIds(follows) {
      let changed = false;
      for (const user of follows) {
        const key = WUM.userKey(user.id);
        const byName = user.username && state.keep[nameKey(user.username)];
        const current = state.keep[key] || byName;
        if (!current) continue;
        const updated = entryFor(user, current);
        if (byName || ['username', 'displayName', 'imageUrl'].some((f) => updated[f] !== current[f])) {
          state.keep[key] = updated;
          if (byName) delete state.keep[nameKey(user.username)];
          changed = true;
        }
      }
      return changed ? saveKeep() : Promise.resolve();
    },

    exportKeep() {
      return {
        format: EXPORT_FORMAT,
        version: 1,
        exportedAt: new Date().toISOString(),
        accounts: Object.values(state.keep).map(({ id, username, displayName, imageUrl, addedAt }) => ({
          id,
          username,
          displayName,
          imageUrl,
          addedAt,
        })),
      };
    },

    // Accepts an Export file, a JSON array of usernames or entries, or plain
    // text with one username (or profile link) per line. Merges into the
    // keep list and returns how many accounts were new.
    async importKeep(text) {
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Plain text: handled below.
      }
      let items;
      if (parsed && Array.isArray(parsed.accounts)) items = parsed.accounts;
      else if (Array.isArray(parsed)) items = parsed;
      else if (parsed === null) items = text.split(/[\s,;]+/);
      else throw new Error('this file is not a keep list export or a list of usernames');

      let added = 0;
      for (const item of items) {
        if (item && typeof item === 'object' && item.id) {
          const key = WUM.userKey(item.id);
          if (state.keep[key]) continue;
          state.keep[key] = entryFor(item, item);
          delete state.keep[nameKey(item.username)];
          added++;
          continue;
        }
        const username = WUM.cleanUsername(typeof item === 'string' ? item : item && item.username);
        if (!username || username === 'username' || state.keep[nameKey(username)]) continue;
        if (Object.values(state.keep).some((e) => String(e.username).toLowerCase() === username)) continue;
        state.keep[nameKey(username)] = { key: nameKey(username), username, displayName: '', imageUrl: '', addedAt: Date.now() };
        added++;
      }
      if (added) await saveKeep();
      return added;
    },

    saveSettings(patch) {
      state.settings = { ...state.settings, ...patch };
      return storage.local.set({ settings: state.settings });
    },

    saveLastRun(run) {
      state.lastRun = run && run.accounts.length ? run : null;
      return state.lastRun ? storage.local.set({ lastRun: state.lastRun }) : storage.local.remove('lastRun');
    },
  };
})();
