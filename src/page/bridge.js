// Page bridge: runs in whatnot.com's own JavaScript world (manifest
// "world": "MAIN") and makes GraphQL calls for the content scripts.
//
// Going through the page's fetch means each request carries the session
// cookie and passes through whatever hooks the site installs on fetch (its
// anti-bot SDK among them), exactly like the site's own requests. Nothing
// here patches or wraps the page; the content scripts talk to it with
// window.postMessage.
(() => {
  'use strict';

  if (window.__wumBridge) return;
  window.__wumBridge = true;

  const FROM_CONTENT = 'wum:content';
  const FROM_BRIDGE = 'wum:bridge';
  const ENDPOINT = '/services/graphql/';

  function cookie(name) {
    const hit = document.cookie.split('; ').find((c) => c.startsWith(name + '='));
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : undefined;
  }

  function tabId() {
    try {
      return JSON.parse(sessionStorage.getItem('TabID')) || undefined;
    } catch {
      return undefined;
    }
  }

  // The headers whatnot-web sends with its own GraphQL calls, filled in from
  // what the page keeps in window.__whatnot__, cookies and sessionStorage.
  // Values that can't be found are left out; the API accepts requests
  // without them.
  function headers() {
    const ctx = (window.__whatnot__ && window.__whatnot__.loggerContext) || {};
    const xw = ctx.x_whatnot || {};
    const all = {
      accept: '*/*',
      'content-type': 'application/json',
      authorization: 'Cookie', // authenticate with the session cookie
      'accept-language': navigator.language || 'en-US',
      'x-client-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
      'x-whatnot-app': 'whatnot-web',
      'x-whatnot-app-context': 'next-js/browser',
      'x-whatnot-app-version': xw.web_version,
      'x-whatnot-app-session-id': (ctx.usr && ctx.usr.appsid) || cookie('whatnot-app-session-id'),
      'x-whatnot-app-user-session-id': xw.usid || cookie('usid'),
      'x-whatnot-tab-id': tabId(),
    };
    for (const key of Object.keys(all)) if (!all[key]) delete all[key];
    return all;
  }

  async function graphql({ operationName, query, variables }) {
    const res = await window.fetch(`${ENDPOINT}?operationName=${encodeURIComponent(operationName)}&ssr=0`, {
      method: 'POST',
      credentials: 'include',
      headers: headers(),
      body: JSON.stringify({ operationName, variables, query }),
    });
    // The body goes back as text: the content script parses it in its own
    // world, so it never has to read objects that belong to the page.
    return { status: res.status, text: await res.text(), retryAfter: res.headers.get('retry-after') };
  }

  window.addEventListener('message', async (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.channel !== FROM_CONTENT) return;
    const reply = (body) => window.postMessage({ channel: FROM_BRIDGE, id: msg.id, ...body }, location.origin);
    if (msg.type === 'ping') {
      reply({ ok: true });
    } else if (msg.type === 'graphql') {
      try {
        reply({ ok: true, ...(await graphql(msg)) });
      } catch (err) {
        reply({ ok: false, error: String((err && err.message) || err) });
      }
    }
  });
})();
