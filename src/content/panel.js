// The on-page UI: a round launcher button and a panel with three tabs
// (Following, Keep list, Options) above a footer that holds the bulk-unfollow
// controls. It lives in a shadow root attached to <html>, outside <body>, so
// whatnot.com's styles and React rendering leave it alone.
(() => {
  'use strict';
  const WUM = globalThis.WUM;
  const { h, store, api, plural } = WUM;

  // "User minus" icon, built from DOM nodes rather than parsed from markup.
  const icon = () =>
    h(
      'svg:svg',
      {
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
      },
      h('svg:path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }),
      h('svg:circle', { cx: '9', cy: '7', r: '4' }),
      h('svg:path', { d: 'M22 11h-6' }),
    );
  const ACTIVE = new Set(['running', 'paused', 'waiting']);
  // How often (in accounts) a running unfollow saves its undo record.
  const UNDO_SAVE_EVERY = 10;

  const slim = (user) => ({
    id: user.id,
    username: user.username,
    displayName: user.displayName || '',
    imageUrl: (user.profileImage && user.profileImage.url) || user.imageUrl || '',
  });

  WUM.createPanel = () => {
    const s = {
      me: null,
      follows: [],
      rows: new Map(), // userKey -> row in the Following list
      outcome: new Map(), // userKey -> 'unfollowed' | 'refollowed' | 'failed', from runs since the last load
      reasons: new Map(), // userKey -> why it failed
      load: 'idle', // idle | loading | ready | signed-out | error
      loadError: '',
      loaded: 0,
      filter: '',
      show: 'all', // all | unfollow | keep
      tab: 'following',
      confirming: false,
      runner: null,
      run: null, // latest runner state; null when no run is showing
      runKind: null, // 'unfollow' | 'refollow'
      runSpeed: null,
    };

    const keyOf = (user) => WUM.userKey(user.id);
    const isRunning = () => Boolean(s.run && ACTIVE.has(s.run.status));
    const toUnfollow = () => s.follows.filter((u) => !store.isKept(u) && s.outcome.get(keyOf(u)) !== 'unfollowed');
    const keptCount = () => s.follows.filter((u) => store.isKept(u)).length;

    // ---------- Skeleton ----------

    const host = h('div', { id: 'whatnot-unfollow-manager' });
    const shadow = host.attachShadow({ mode: 'open' });

    const launcher = h(
      'button',
      {
        type: 'button',
        class: 'launcher',
        title: 'Unfollow Manager (Alt+Shift+U)',
        'aria-label': 'Open Unfollow Manager',
        onclick: () => toggle(),
      },
      icon(),
    );

    const summary = h('div', { class: 'summary', 'aria-live': 'polite' });
    const tabButtons = {
      following: h('button', { type: 'button', role: 'tab', onclick: () => selectTab('following') }, 'Following'),
      keep: h('button', { type: 'button', role: 'tab', onclick: () => selectTab('keep') }, 'Keep list'),
      options: h('button', { type: 'button', role: 'tab', onclick: () => selectTab('options') }, 'Options'),
    };

    // Following tab
    const filterInput = h('input', {
      type: 'search',
      placeholder: 'Filter by name or @username',
      'aria-label': 'Filter accounts',
      oninput: () => {
        s.filter = filterInput.value;
        applyFilter();
      },
    });
    const showSelect = h(
      'select',
      {
        'aria-label': 'Show',
        onchange: () => {
          s.show = showSelect.value;
          applyFilter();
        },
      },
      h('option', { value: 'all' }, 'All'),
      h('option', { value: 'unfollow' }, 'To unfollow'),
      h('option', { value: 'keep' }, 'Kept'),
    );
    const shownCount = h('span');
    const keepShownBtn = h('button', { type: 'button', class: 'link-btn', hidden: true, onclick: () => keepAllShown() });
    const listStatus = h('div', { class: 'status', hidden: true });
    const list = h('div', { class: 'list', role: 'list' });
    const followingTab = h(
      'div',
      { class: 'tab', role: 'tabpanel' },
      h('div', { class: 'toolbar' }, filterInput, showSelect),
      h('div', { class: 'subbar' }, shownCount, keepShownBtn),
      listStatus,
      list,
    );

    // Keep list tab
    const addInput = h('input', {
      type: 'text',
      placeholder: '@username or profile link',
      'aria-label': 'Account to add to the keep list',
      onkeydown: (e) => {
        if (e.key === 'Enter') addByName();
      },
    });
    const addBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => addByName() }, 'Add');
    const keepMsg = h('div', { class: 'note keep-msg', 'aria-live': 'polite' });
    const keepCount = h('div', { class: 'subbar' });
    const keepList = h('div', { class: 'list', role: 'list' });
    const fileInput = h('input', {
      type: 'file',
      accept: '.json,.txt,.csv,application/json,text/plain',
      hidden: true,
      onchange: () => importFile(),
    });
    const keepTab = h(
      'div',
      { class: 'tab', role: 'tabpanel', hidden: true },
      h('div', { class: 'toolbar' }, addInput, addBtn),
      keepMsg,
      keepCount,
      keepList,
      h(
        'div',
        { class: 'keep-tools' },
        h('button', { type: 'button', class: 'btn', onclick: () => exportKeep() }, 'Export'),
        h('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, 'Import'),
        fileInput,
      ),
      h(
        'div',
        { class: 'note fineprint' },
        'Saved in this browser, so it survives restarts. Export a copy before removing the add-on or switching computers.',
      ),
    );

    // Options tab
    const speedChoices = Object.entries(WUM.SPEEDS).map(([value, pace]) => {
      const input = h('input', { type: 'radio', name: 'wum-speed', value, onchange: () => store.saveSettings({ speed: value }) });
      return { value, input, label: h('label', { class: 'option' }, input, h('span', {}, h('b', {}, pace.label), `, ${pace.hint}`)) };
    });
    const launcherToggle = h('input', {
      type: 'checkbox',
      onchange: () => store.saveSettings({ showLauncher: launcherToggle.checked }),
    });
    const undoBox = h('div');
    const optionsTab = h(
      'div',
      { class: 'tab', role: 'tabpanel', hidden: true },
      h(
        'div',
        { class: 'pane' },
        h(
          'fieldset',
          {},
          h('legend', {}, 'Speed'),
          speedChoices.map((c) => c.label),
          h('div', { class: 'note' }, 'Slower is gentler on Whatnot and less likely to hit rate limits. Applies to the next run.'),
        ),
        h(
          'fieldset',
          {},
          h('legend', {}, 'Launcher'),
          h(
            'label',
            { class: 'option' },
            launcherToggle,
            h('span', {}, 'Show the round button in the corner of Whatnot pages. The toolbar icon and Alt+Shift+U open the panel either way.'),
          ),
        ),
        h('fieldset', {}, h('legend', {}, 'Undo'), undoBox),
      ),
    );

    // Footer: the big button and its confirmation when idle, progress during
    // and after a run. Elements are built once and updated in place, so a
    // click never lands on a button that was just replaced.
    const idle = {
      main: h('button', {
        type: 'button',
        class: 'btn danger block',
        onclick: () => {
          s.confirming = true;
          renderFooter();
        },
      }),
      ask: h('div'),
      cancel: h('button', {
        type: 'button',
        class: 'btn',
        onclick: () => {
          s.confirming = false;
          renderFooter();
        },
      }, 'Cancel'),
      yes: h('button', { type: 'button', class: 'btn danger', onclick: () => startRun('unfollow', toUnfollow()) }, 'Yes, unfollow'),
      note: h('div', { class: 'note' }),
    };
    idle.confirmRow = h('div', { class: 'btn-row' }, idle.cancel, idle.yes);

    const prog = {
      bar: h('div'),
      counts: h('div', { class: 'counts' }),
      line: h('div', { class: 'note' }),
      pause: h('button', {
        type: 'button',
        class: 'btn',
        onclick: () => (s.run.status === 'paused' ? s.runner.resume() : s.runner.pause()),
      }),
      stop: h('button', { type: 'button', class: 'btn', onclick: () => s.runner.stop() }, 'Stop'),
      retry: h('button', {
        type: 'button',
        class: 'btn',
        onclick: () => startRun(s.runKind, s.run.failed.map((f) => f.user), { retry: true }),
      }),
      reload: h('button', { type: 'button', class: 'btn primary', onclick: () => loadFollows() }, 'Reload list'),
    };
    prog.track = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, prog.bar);

    const footer = h('footer', { hidden: true });

    const panel = h(
      'section',
      { class: 'panel', role: 'dialog', 'aria-label': 'Unfollow Manager', hidden: true },
      h(
        'header',
        {},
        h('h2', {}, 'Unfollow Manager'),
        h('button', { type: 'button', class: 'icon-btn', title: 'Close', 'aria-label': 'Close', onclick: () => close() }, '×'),
      ),
      summary,
      h('nav', { class: 'tabs', role: 'tablist' }, Object.values(tabButtons)),
      followingTab,
      keepTab,
      optionsTab,
      footer,
    );

    // Keep Whatnot's keyboard shortcuts from firing while typing in the panel.
    for (const type of ['keydown', 'keyup', 'keypress']) {
      panel.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === 'keydown' && e.key === 'Escape') close();
      });
    }

    shadow.append(h('style', {}, WUM.STYLES), launcher, panel);

    // Attach once the page has loaded (so React's hydration is done with
    // the document), and put the panel back if a re-render ever removes it.
    const attach = () => {
      if (!host.isConnected) document.documentElement.append(host);
    };
    if (document.readyState === 'complete') attach();
    else window.addEventListener('load', attach, { once: true });
    new MutationObserver(() => {
      if (document.readyState === 'complete') attach();
    }).observe(document.documentElement, { childList: true });

    window.addEventListener('beforeunload', (e) => {
      if (!isRunning()) return;
      e.preventDefault();
      e.returnValue = ''; // asks "Leave site?" so a run isn't cut off by accident
    });

    store.subscribe(() => renderAll());

    // ---------- Actions ----------

    function open() {
      panel.hidden = false;
      if (s.load !== 'loading' && s.load !== 'ready') loadFollows();
      renderAll();
    }

    function close() {
      panel.hidden = true;
    }

    function toggle() {
      if (panel.hidden) open();
      else close();
    }

    function selectTab(tab) {
      s.tab = tab;
      renderAll();
    }

    async function loadFollows() {
      if (s.load === 'loading' || isRunning()) return;
      Object.assign(s, { load: 'loading', loaded: 0, loadError: '', confirming: false, run: null, runner: null });
      s.outcome.clear();
      s.reasons.clear();
      renderAll();
      try {
        s.me = await api.me();
        if (s.me) {
          s.follows = await api.listFollowing(s.me.publicId, (count) => {
            s.loaded = count;
            renderSummary();
            renderStatus();
          });
          await store.attachIds(s.follows);
          s.load = 'ready';
        } else {
          s.follows = [];
          s.load = 'signed-out';
        }
      } catch (err) {
        s.follows = [];
        s.load = 'error';
        s.loadError = err.message || String(err);
      }
      buildRows();
      renderAll();
    }

    function toggleKeep(user) {
      store.setKept([user], !store.isKept(user));
      renderAll();
    }

    function keepAllShown() {
      store.setKept(s.follows.filter((u) => matches(u) && !store.isKept(u)), true);
      renderAll();
    }

    async function addByName() {
      const username = WUM.cleanUsername(addInput.value);
      if (!username) return;
      addBtn.disabled = true;
      setKeepMsg(`Looking up @${username}…`);
      try {
        const user = await api.getUser(username);
        if (!user) {
          setKeepMsg(`There's no Whatnot account called @${username}.`, 'error');
        } else if (store.isKept(user)) {
          setKeepMsg(`@${user.username} is already on your keep list.`);
        } else {
          store.setKept([user], true);
          addInput.value = '';
          setKeepMsg(`Added @${user.username}.`, 'ok');
          renderAll();
        }
      } catch (err) {
        setKeepMsg(err.message, 'error');
      } finally {
        addBtn.disabled = false;
      }
    }

    function setKeepMsg(text, kind = '') {
      keepMsg.textContent = text;
      keepMsg.className = `note keep-msg ${kind}`;
    }

    function exportKeep() {
      const blob = new Blob([JSON.stringify(store.exportKeep(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = h('a', { href: url, download: `whatnot-keep-list-${new Date().toISOString().slice(0, 10)}.json` });
      shadow.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setKeepMsg(`Exported ${plural(store.keepEntries().length, 'account')}.`, 'ok');
    }

    async function importFile() {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      try {
        const added = await store.importKeep(await file.text());
        setKeepMsg(added ? `Imported ${plural(added, 'new account')}.` : 'Everything in that file is already on your keep list.', 'ok');
      } catch (err) {
        setKeepMsg(`Couldn't import: ${err.message}.`, 'error');
      }
      renderAll();
    }

    function refollowLastRun() {
      const last = store.lastRun;
      if (!last || isRunning()) return;
      if (!window.confirm(`Follow these ${plural(last.accounts.length, 'account')} again?`)) return;
      startRun('refollow', last.accounts);
    }

    // kind 'unfollow' or 'refollow'. A retry adds to the previous run's undo
    // record instead of starting a new one.
    function startRun(kind, accounts, { retry = false } = {}) {
      if (isRunning() || !accounts.length) return;
      const follow = kind === 'refollow';
      Object.assign(s, { confirming: false, runKind: kind, runSpeed: store.settings.speed });
      for (const user of accounts) {
        s.outcome.delete(keyOf(user));
        s.reasons.delete(keyOf(user));
      }

      // Unfollow runs record whom they removed so Options > Undo can follow
      // them again. The record is only replaced once this run unfollows
      // someone, so an aborted run doesn't wipe the previous one.
      const previous = retry && store.lastRun ? store.lastRun : { startedAt: Date.now(), accounts: [] };
      let saved = 0;
      const saveUndo = (succeeded) => {
        const known = new Set(previous.accounts.map(keyOf));
        const accounts = [...previous.accounts, ...succeeded.filter((u) => !known.has(keyOf(u))).map(slim)];
        store.saveLastRun({ startedAt: previous.startedAt, accounts });
      };

      let seenOk = 0;
      let seenFailed = 0;
      s.runner = WUM.createRunner({
        accounts,
        follow,
        speed: s.runSpeed,
        skip: follow ? undefined : (user) => store.isKept(user),
        onUpdate: (run) => {
          s.run = run;
          for (const user of run.succeeded.slice(seenOk)) {
            s.outcome.set(keyOf(user), follow ? 'refollowed' : 'unfollowed');
            refreshRow(user);
          }
          for (const { user, error } of run.failed.slice(seenFailed)) {
            s.outcome.set(keyOf(user), 'failed');
            s.reasons.set(keyOf(user), error);
            refreshRow(user);
          }
          seenOk = run.succeeded.length;
          seenFailed = run.failed.length;

          const finished = !ACTIVE.has(run.status);
          if (!follow && seenOk > saved && (seenOk - saved >= UNDO_SAVE_EVERY || finished)) {
            saved = seenOk;
            saveUndo(run.succeeded);
          }
          if (follow && finished && seenOk && store.lastRun) {
            // Accounts followed again no longer need undoing.
            const back = new Set(run.succeeded.map(keyOf));
            store.saveLastRun({ ...store.lastRun, accounts: store.lastRun.accounts.filter((a) => !back.has(keyOf(a))) });
          }

          renderSummary();
          renderFooter();
          renderLauncher();
          if (finished) renderAll();
        },
      });
      s.runner.start();
      renderAll();
    }

    // ---------- Rendering ----------

    function avatar(url, name) {
      const initial = () => h('span', { class: 'avatar', 'aria-hidden': 'true' }, (name || '?').charAt(0).toUpperCase());
      if (!url) return initial();
      const img = h('img', { class: 'avatar', src: url, alt: '', loading: 'lazy' });
      img.addEventListener('error', () => img.replaceWith(initial()), { once: true });
      return img;
    }

    function identity(user) {
      return h(
        'a',
        {
          class: 'who',
          href: `/user/${encodeURIComponent(user.username)}`,
          target: '_blank',
          rel: 'noopener',
          title: `Open @${user.username} in a new tab`,
        },
        h('span', { class: 'name' }, user.displayName || user.username),
        h('span', { class: 'handle' }, '@' + user.username),
      );
    }

    function buildRows() {
      s.rows.clear();
      list.replaceChildren(
        ...s.follows.map((user) => {
          const row = h(
            'div',
            { class: 'row', role: 'listitem' },
            avatar(user.profileImage && user.profileImage.url, user.displayName || user.username),
            identity(user),
            h('span', { class: 'tag' }),
            h('button', { type: 'button', class: 'keep', onclick: () => toggleKeep(user) }),
          );
          s.rows.set(keyOf(user), row);
          return row;
        }),
      );
    }

    function refreshRow(user) {
      const row = s.rows.get(keyOf(user));
      if (!row) return;
      const kept = store.isKept(user);
      const outcome = s.outcome.get(keyOf(user));
      row.classList.toggle('kept', kept);
      row.classList.toggle('done', outcome === 'unfollowed');
      row.classList.toggle('failed', outcome === 'failed');
      row.title = outcome === 'failed' ? s.reasons.get(keyOf(user)) || '' : '';
      row.querySelector('.tag').textContent =
        { unfollowed: 'Unfollowed', refollowed: 'Followed again', failed: 'Failed' }[outcome] || '';
      const button = row.querySelector('.keep');
      button.textContent = kept ? '★ Kept' : '☆ Keep';
      button.setAttribute('aria-pressed', String(kept));
      button.title = kept ? 'On your keep list, so it is never unfollowed. Click to remove.' : 'Add to your keep list so it is never unfollowed';
      button.disabled = outcome === 'unfollowed';
    }

    function matches(user) {
      const kept = store.isKept(user);
      if ((s.show === 'keep' && !kept) || (s.show === 'unfollow' && kept)) return false;
      const q = s.filter.trim().replace(/^@/, '').toLowerCase();
      return !q || (user.username || '').toLowerCase().includes(q) || (user.displayName || '').toLowerCase().includes(q);
    }

    function applyFilter() {
      let shown = 0;
      let shownUnkept = 0;
      for (const user of s.follows) {
        const visible = matches(user);
        const row = s.rows.get(keyOf(user));
        if (row) row.hidden = !visible;
        if (visible) {
          shown++;
          if (!store.isKept(user)) shownUnkept++;
        }
      }
      const ready = s.load === 'ready' && s.follows.length > 0;
      shownCount.textContent = ready ? `Showing ${shown.toLocaleString()} of ${s.follows.length.toLocaleString()}` : '';
      keepShownBtn.hidden = !(ready && s.filter.trim() && shownUnkept > 0);
      keepShownBtn.textContent = `Keep all ${shownUnkept.toLocaleString()} shown`;
    }

    function renderSummary() {
      if (s.load === 'ready') {
        summary.replaceChildren(
          'Signed in as ',
          h('b', {}, '@' + s.me.username),
          ` · following ${s.follows.length.toLocaleString()} · keeping ${keptCount().toLocaleString()}`,
        );
      } else {
        summary.textContent = {
          loading: s.loaded ? `Loading the accounts you follow… ${s.loaded.toLocaleString()} so far` : 'Loading…',
          'signed-out': 'Not signed in to Whatnot.',
          error: "Couldn't load your Following list.",
        }[s.load] || '';
      }
    }

    function renderStatus() {
      let content = null;
      if (s.load === 'loading') {
        content = [h('p', {}, s.loaded ? `Loaded ${plural(s.loaded, 'account')}…` : 'Loading the accounts you follow…')];
      } else if (s.load === 'signed-out') {
        content = [
          h('p', {}, 'Sign in to Whatnot to see the accounts you follow. Your keep list works either way.'),
          h('div', { class: 'btn-row' },
            h('a', { class: 'btn primary', href: `/login?redirect=${encodeURIComponent(location.pathname)}` }, 'Log in'),
            h('button', { type: 'button', class: 'btn', onclick: () => loadFollows() }, 'Check again')),
        ];
      } else if (s.load === 'error') {
        content = [h('p', {}, s.loadError), h('button', { type: 'button', class: 'btn primary', onclick: () => loadFollows() }, 'Try again')];
      } else if (s.load === 'ready' && !s.follows.length) {
        content = [h('p', {}, "You aren't following anyone.")];
      }
      listStatus.hidden = !content;
      listStatus.classList.toggle('error', s.load === 'error');
      if (content) listStatus.replaceChildren(...content);
      list.hidden = s.load !== 'ready';
    }

    function renderTabs() {
      for (const [name, button] of Object.entries(tabButtons)) button.setAttribute('aria-selected', String(s.tab === name));
      followingTab.hidden = s.tab !== 'following';
      keepTab.hidden = s.tab !== 'keep';
      optionsTab.hidden = s.tab !== 'options';
      tabButtons.keep.textContent = `Keep list (${store.keepEntries().length.toLocaleString()})`;
    }

    function renderFooter() {
      if (s.run) return renderProgress();
      footer.hidden = s.load !== 'ready';
      if (footer.hidden) return;
      if (footer.firstChild !== idle.main) footer.replaceChildren(idle.main, idle.ask, idle.confirmRow, idle.note);

      const targets = toUnfollow().length;
      const kept = keptCount();
      const speed = store.settings.speed;
      const time = WUM.formatDuration(WUM.estimateMs(targets, speed));
      s.confirming = s.confirming && targets > 0;

      idle.main.hidden = s.confirming;
      idle.main.disabled = !targets;
      idle.main.textContent = targets ? `Unfollow ${plural(targets, 'account')}` : 'Nothing to unfollow';
      idle.ask.hidden = idle.confirmRow.hidden = !s.confirming;
      idle.ask.replaceChildren(h('b', {}, `Unfollow ${plural(targets, 'account')}?`), ` It takes ${time}.`);
      if (!targets) {
        idle.note.textContent = s.follows.length ? 'Every account you follow is on your keep list.' : '';
      } else if (kept) {
        idle.note.textContent = `Keeps the ${plural(kept, 'account')} on your keep list. Takes ${time} at ${WUM.SPEEDS[speed].label.toLowerCase()} speed.`;
      } else {
        idle.note.textContent = 'Your keep list is empty, so this unfollows everyone. Use ☆ Keep on accounts you want to stay followed.';
      }
      idle.note.classList.toggle('error', Boolean(targets && !kept));
    }

    function renderProgress() {
      const run = s.run;
      const refollow = s.runKind === 'refollow';
      const active = ACTIVE.has(run.status);
      footer.hidden = false;
      if (footer.firstChild !== prog.track) {
        footer.replaceChildren(prog.track, prog.counts, prog.line, h('div', { class: 'btn-row' }, prog.pause, prog.stop, prog.retry, prog.reload));
      }

      const pct = run.total ? Math.round((run.index / run.total) * 100) : 100;
      prog.bar.style.width = `${pct}%`;
      prog.track.setAttribute('aria-valuenow', String(pct));

      const counts = [`${refollow ? 'Followed again' : 'Unfollowed'} ${run.succeeded.length.toLocaleString()} of ${run.total.toLocaleString()}`];
      if (run.failed.length) counts.push(`${run.failed.length.toLocaleString()} failed`);
      if (run.skipped.length) counts.push(`${run.skipped.length.toLocaleString()} skipped (kept)`);
      prog.counts.textContent = counts.join(' · ');

      const left = WUM.formatDuration(WUM.estimateMs(run.total - run.index, s.runSpeed));
      prog.line.textContent = {
        running: `${WUM.capitalize(left)} left. Keep this tab open; you can keep browsing Whatnot in it.`,
        waiting: run.message,
        paused: 'Paused. Nothing more happens until you resume.',
        done: 'Finished.',
        stopped: 'Stopped. Accounts not reached yet are still followed.',
        halted: run.message,
      }[run.status];
      prog.line.classList.toggle('error', run.status === 'halted');

      prog.pause.hidden = prog.stop.hidden = !active;
      prog.pause.textContent = run.status === 'paused' ? 'Resume' : 'Pause';
      prog.pause.classList.toggle('primary', run.status === 'paused');
      prog.retry.hidden = active || !run.failed.length;
      prog.retry.textContent = `Retry ${plural(run.failed.length, 'failed account')}`;
      prog.reload.hidden = active;
    }

    function renderKeepTab() {
      const entries = store.keepEntries().sort((a, b) => String(a.username).localeCompare(String(b.username)));
      const followed = new Set(s.follows.map(keyOf));
      keepCount.textContent = entries.length
        ? `${plural(entries.length, 'account')} on your keep list`
        : 'Nothing here yet. Use ☆ Keep on the Following tab, or add a username above.';
      keepList.replaceChildren(
        ...entries.map((entry) =>
          h(
            'div',
            { class: 'row kept', role: 'listitem' },
            avatar(entry.imageUrl, entry.displayName || entry.username),
            identity(entry),
            s.load === 'ready' && !followed.has(entry.key)
              ? h('span', { class: 'tag', title: "You don't follow this account at the moment" }, 'Not followed')
              : null,
            h('button', {
              type: 'button',
              class: 'keep',
              title: 'Remove from your keep list',
              onclick: () => {
                store.removeEntry(entry.key);
                renderAll();
              },
            }, 'Remove'),
          ),
        ),
      );
    }

    function renderOptions() {
      for (const choice of speedChoices) choice.input.checked = choice.value === store.settings.speed;
      launcherToggle.checked = store.settings.showLauncher;
      const last = store.lastRun;
      if (!last) {
        undoBox.replaceChildren(h('div', { class: 'note' }, 'After a bulk unfollow, you can follow those accounts again from here.'));
        return;
      }
      const when = new Date(last.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      undoBox.replaceChildren(
        h('p', { style: 'margin:0 0 8px' }, `Your last run (${when}) unfollowed ${plural(last.accounts.length, 'account')}.`),
        h('button', { type: 'button', class: 'btn', disabled: isRunning(), onclick: () => refollowLastRun() }, 'Follow them again'),
      );
    }

    function renderLauncher() {
      launcher.hidden = !store.settings.showLauncher;
      launcher.classList.toggle('busy', isRunning());
      launcher.title = isRunning() ? 'Unfollow Manager: working…' : 'Unfollow Manager (Alt+Shift+U)';
    }

    function renderAll() {
      renderSummary();
      renderTabs();
      renderStatus();
      s.follows.forEach(refreshRow);
      applyFilter();
      renderFooter();
      if (s.tab === 'keep') renderKeepTab();
      if (s.tab === 'options') renderOptions();
      renderLauncher();
    }

    renderAll();
    return { open, close, toggle };
  };
})();
