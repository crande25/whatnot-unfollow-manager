// Shared helpers. Every content script adds to the WUM namespace, which lives
// in this add-on's isolated world and is invisible to the page.
(() => {
  'use strict';
  const WUM = (globalThis.WUM = globalThis.WUM || {});

  // Extension APIs. Firefox's `browser` namespace returns promises.
  WUM.ext = globalThis.browser || globalThis.chrome;

  WUM.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  WUM.randomBetween = (min, max) => min + Math.random() * (max - min);

  // Whatnot IDs are Relay global IDs such as base64("PublicUserNode:21123").
  // The number after the colon identifies the account whatever the node type,
  // so the keep list is keyed by it.
  WUM.userKey = (globalId) => {
    try {
      const decoded = atob(globalId);
      const colon = decoded.lastIndexOf(':');
      if (colon > 0) return decoded.slice(colon + 1);
    } catch {
      // Not base64: use the ID as it is.
    }
    return String(globalId);
  };

  // Accepts "name", "@name" or a profile link and returns "name" in lowercase.
  WUM.cleanUsername = (input) =>
    String(input || '')
      .trim()
      .replace(/^https?:\/\/(www\.)?whatnot\.com\/(\w{2}(-\w{2})?\/)?user\//i, '')
      .replace(/^@/, '')
      .split(/[/?#\s]/)[0]
      .toLowerCase();

  WUM.plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

  // "less than a minute", "about 12 min", "about 1 h 5 min"
  WUM.formatDuration = (ms) => {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'less than a minute';
    if (minutes < 60) return `about ${minutes} min`;
    return `about ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  };

  WUM.capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // Small DOM builder: h('button', { class: 'btn', onclick: fn }, 'Label').
  // Booleans set properties (hidden, disabled, checked); false and null skip.
  // Tags starting with "svg:" are created in the SVG namespace.
  WUM.h = (tag, props, ...children) => {
    const el = tag.startsWith('svg:')
      ? document.createElementNS('http://www.w3.org/2000/svg', tag.slice(4))
      : document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.setAttribute('class', value);
      else if (typeof value === 'boolean') el[key] = value;
      else el.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) {
      if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
    }
    return el;
  };
})();
