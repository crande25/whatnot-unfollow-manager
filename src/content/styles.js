// Styles for the panel's shadow root. Kept in JS so nothing has to be exposed
// to the page as a web-accessible resource.
(() => {
  'use strict';
  globalThis.WUM.STYLES = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }

.launcher, .panel {
  --ink: #101828; --muted: #667085; --line: #eaecf0; --field: #d0d5dd;
  --accent: #ffd60a; --accent-ink: #111111; --accent-soft: #fffaeb;
  --danger: #d92d20; --ok: #12b76a;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--ink);
}

.launcher {
  position: fixed; left: 20px; bottom: 20px; z-index: 2147483000;
  width: 48px; height: 48px; border-radius: 50%; border: 0; cursor: pointer;
  display: grid; place-items: center;
  background: var(--accent); color: var(--accent-ink);
  box-shadow: 0 4px 14px rgba(16, 24, 40, .28);
}
.launcher:hover { filter: brightness(.96); }
.launcher svg { width: 24px; height: 24px; }
.launcher.busy::after {
  content: ""; position: absolute; inset: -4px; border-radius: 50%;
  border: 3px solid transparent; border-top-color: var(--danger);
  animation: wum-spin 1s linear infinite;
}
@keyframes wum-spin { to { transform: rotate(360deg); } }

.panel {
  position: fixed; top: 76px; right: 16px; z-index: 2147483001;
  width: min(400px, calc(100vw - 32px)); height: min(640px, calc(100vh - 96px));
  display: flex; flex-direction: column; overflow: hidden;
  background: #fff; border-radius: 14px;
  box-shadow: 0 12px 40px rgba(16, 24, 40, .22), 0 0 0 1px rgba(16, 24, 40, .08);
}

header { display: flex; align-items: center; gap: 8px; padding: 12px 10px 2px 16px; }
header h2 { flex: 1; margin: 0; font-size: 16px; font-weight: 700; }
.icon-btn {
  width: 32px; height: 32px; border: 0; border-radius: 8px; cursor: pointer;
  background: transparent; color: var(--muted); font-size: 20px; line-height: 1;
}
.icon-btn:hover { background: #f2f4f7; color: var(--ink); }

.summary { padding: 0 16px 8px; color: var(--muted); font-size: 13px; }
.summary b { color: var(--ink); font-weight: 600; }

.tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid var(--line); }
.tabs button {
  border: 0; background: none; cursor: pointer; font: inherit; font-weight: 600;
  color: var(--muted); padding: 8px 8px 9px; margin-bottom: -1px;
  border-bottom: 2px solid transparent;
}
.tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); }

.tab { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.toolbar { display: flex; gap: 6px; padding: 10px 16px 6px; }
.toolbar input { flex: 1; }
input[type="search"], input[type="text"], select {
  min-width: 0; padding: 7px 10px; border: 1px solid var(--field); border-radius: 8px;
  font: inherit; color: inherit; background: #fff;
}
input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid #84adff; outline-offset: 1px; }

.subbar {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  min-height: 24px; padding: 0 16px 4px; font-size: 12px; color: var(--muted);
}
.link-btn { border: 0; background: none; padding: 0; cursor: pointer; font: inherit; font-weight: 600; color: #175cd3; }

.list { flex: 1; min-height: 80px; overflow-y: auto; overscroll-behavior: contain; padding: 0 8px 8px; }
.row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 10px; }
.row:hover { background: #f9fafb; }
.row.kept { background: var(--accent-soft); }
.row.done { opacity: .55; }
.row.done .name { text-decoration: line-through; }
.avatar {
  flex: none; width: 34px; height: 34px; border-radius: 50%; object-fit: cover;
  display: grid; place-items: center; background: var(--line); color: var(--muted); font-weight: 700;
}
.who { flex: 1; min-width: 0; display: flex; flex-direction: column; color: inherit; text-decoration: none; }
.who:hover .name { text-decoration: underline; }
.who .name, .who .handle { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.who .name { font-weight: 600; }
.who .handle { font-size: 12px; color: var(--muted); }
.tag { flex: none; padding: 2px 6px; border-radius: 6px; font-size: 11px; font-weight: 600; background: #f2f4f7; color: #475467; }
.tag:empty { display: none; }
.row.done .tag { background: #ecfdf3; color: #067647; }
.row.failed .tag { background: #fef3f2; color: #b42318; }

.keep {
  flex: none; display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
  padding: 4px 10px; border: 1px solid var(--field); border-radius: 999px;
  background: #fff; color: #344054; font: inherit; font-size: 12px; font-weight: 600;
}
.keep:hover { border-color: #98a2b3; }
.keep[aria-pressed="true"] { background: var(--accent); border-color: #e0b700; color: var(--accent-ink); }
.keep:disabled { opacity: .5; cursor: default; }

.status { padding: 28px 20px; text-align: center; color: #475467; }
.status p { margin: 0 0 12px; }
.status.error p { color: #b42318; }

footer { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px 14px; border-top: 1px solid var(--line); }
.btn {
  padding: 8px 14px; border: 1px solid var(--field); border-radius: 10px; cursor: pointer;
  background: #fff; color: #344054; font: inherit; font-weight: 600; text-decoration: none; text-align: center;
}
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--ink); border-color: var(--ink); color: #fff; }
.btn.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
.btn:not(.primary):not(.danger):hover:not(:disabled) { background: #f9fafb; }
.btn.primary:hover:not(:disabled), .btn.danger:hover:not(:disabled) { filter: brightness(1.12); }
.btn.block { width: 100%; padding: 11px 14px; font-size: 15px; }
.btn-row { display: flex; gap: 8px; }
.btn-row .btn { flex: 1; }

.progress { height: 8px; border-radius: 4px; background: var(--line); overflow: hidden; }
.progress > div { height: 100%; width: 0; background: var(--ok); transition: width .3s; }
.counts { font-weight: 600; }
.note { font-size: 12px; color: var(--muted); }
.note.error, .error { color: #b42318; }
.note.ok { color: #067647; }

.pane { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px; }
fieldset { margin: 0 0 16px; padding: 0; border: 0; }
legend { margin-bottom: 6px; padding: 0; font-weight: 700; }
.option { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; cursor: pointer; }
.option input { margin-top: 3px; }
.keep-tools { display: flex; gap: 8px; padding: 8px 16px 4px; }
.keep-tools .btn { flex: 1; }
.keep-msg { min-height: 18px; padding: 0 16px 4px; }
.fineprint { padding: 4px 16px 12px; }
`;
})();
