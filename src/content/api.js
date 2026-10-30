// Whatnot GraphQL client. The requests themselves are made by the page
// bridge (src/page/bridge.js) so they run in the page's own context.
//
// The operations mirror the ones whatnot-web uses (same names, same
// variables), trimmed to the fields this add-on needs:
//   CurrentUser  who is signed in
//   GetUser      look up an account by username
//   Following    the accounts a user follows, 24-50 per page
//   FollowUser   follow (active: true) or unfollow (active: false) an account
(() => {
  'use strict';
  const WUM = globalThis.WUM;

  const FROM_CONTENT = 'wum:content';
  const FROM_BRIDGE = 'wum:bridge';

  const CURRENT_USER = `query CurrentUser {
  currentUser: me { id username followingCount }
}`;

  const GET_USER = `query GetUser($username: String) {
  getUser(username: $username, excludeBanned: false) {
    id username displayName followingCount profileImage { url }
  }
}`;

  const FOLLOWING = `query Following($userId: ID!, $after: String, $first: Int) {
  userFollowing(userId: $userId, after: $after, first: $first) {
    pageInfo { endCursor hasNextPage }
    edges { node { id username displayName isFollowing profileImage { url } } }
  }
}`;

  const FOLLOW_USER = `mutation FollowUser($id: ID!, $active: Boolean, $followSource: UserFollowUserChangeSource = null) {
  followUser(id: $id, active: $active, followSource: $followSource) {
    success
    user { id isFollowing }
  }
}`;

  // The site asks for 24 per page; try 50 first and drop to 24 if refused.
  const PAGE_SIZES = [50, 24];
  const PAGE_PAUSE_MS = 250;
  const LOAD_RETRY_WAITS_MS = [2000, 5000, 15000];

  // retryable: worth trying again after a wait (rate limit, server hiccup).
  // fatal: no point continuing at all (signed out, blocked).
  class ApiError extends Error {
    constructor(message, { status = 0, retryable = false, fatal = false, retryAfterMs = 0 } = {}) {
      super(message);
      this.status = status;
      this.retryable = retryable;
      this.fatal = fatal;
      this.retryAfterMs = retryAfterMs;
    }
  }

  const pending = new Map();
  let nextId = 1;

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.channel !== FROM_BRIDGE || !pending.has(msg.id)) return;
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  });

  function callBridge(type, payload, timeoutMs) {
    const id = `${Date.now()}-${nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new ApiError('Whatnot did not answer in time.', { retryable: true }));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      window.postMessage({ channel: FROM_CONTENT, id, type, ...payload }, location.origin);
    });
  }

  // Pings the bridge once; later calls reuse the answer.
  let bridgeReady = null;
  function ensureBridge() {
    if (!bridgeReady) {
      bridgeReady = callBridge('ping', {}, 5000).catch(() => {
        bridgeReady = null;
        throw new ApiError('The add-on could not talk to the page. Reload the page and try again.', { fatal: true });
      });
    }
    return bridgeReady;
  }

  function retryAfterMs(header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const date = Date.parse(header || '');
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
  }

  async function graphql(operationName, query, variables = {}) {
    await ensureBridge();
    const res = await callBridge('graphql', { operationName, query, variables }, 30000);
    if (!res.ok) throw new ApiError(`Couldn't reach Whatnot (${res.error}).`, { retryable: true });

    const { status } = res;
    let json = null;
    try {
      json = JSON.parse(res.text);
    } catch {
      // Not JSON (an error or challenge page); reported below by status.
    }
    if (status === 401) throw new ApiError('You are signed out of Whatnot. Sign in and try again.', { status, fatal: true });
    if (status === 403) {
      throw new ApiError('Whatnot refused the request (HTTP 403). Reload the page, wait a few minutes, and try again.', {
        status,
        fatal: true,
      });
    }
    if (status === 429) {
      throw new ApiError('Whatnot is rate-limiting requests.', { status, retryable: true, retryAfterMs: retryAfterMs(res.retryAfter) });
    }
    if (status >= 500) throw new ApiError(`Whatnot had a server error (HTTP ${status}).`, { status, retryable: true });
    if (!json) throw new ApiError(`Unexpected response from Whatnot (HTTP ${status}).`, { status });

    const data = json.data || {};
    const errors = json.errors || [];
    if (errors.length && Object.values(data).every((v) => v == null)) {
      const message = errors.map((e) => e.message).join('; ');
      if (/rate|too many|throttl/i.test(message)) throw new ApiError(message, { status, retryable: true });
      if (/authenticat|log ?in|sign ?in|permission/i.test(message)) throw new ApiError(message, { status, fatal: true });
      throw new ApiError(message, { status });
    }
    return data;
  }

  async function withRetry(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!err.retryable || attempt >= LOAD_RETRY_WAITS_MS.length) throw err;
        await WUM.sleep(Math.max(LOAD_RETRY_WAITS_MS[attempt], err.retryAfterMs || 0));
      }
    }
  }

  async function getUser(username) {
    const data = await graphql('GetUser', GET_USER, { username });
    return data.getUser || null;
  }

  WUM.api = {
    ApiError,

    getUser,

    // The signed-in account, or null when signed out. publicId is the profile
    // ID that the Following query expects (`me` returns a different node type).
    async me() {
      const data = await graphql('CurrentUser', CURRENT_USER);
      const me = data.currentUser;
      if (!me) return null;
      const profile = me.username ? await getUser(me.username) : null;
      return {
        ...me,
        publicId: profile ? profile.id : me.id,
        followingCount: profile ? profile.followingCount : me.followingCount,
      };
    },

    // Every account `userId` follows, in Whatnot's order. onProgress(count)
    // is called after each page.
    async listFollowing(userId, onProgress) {
      const sizes = [...PAGE_SIZES];
      const seen = new Set();
      const follows = [];
      let after = null;
      for (;;) {
        let page;
        try {
          const data = await withRetry(() => graphql('Following', FOLLOWING, { userId, after, first: sizes[0] }));
          page = data.userFollowing;
          if (!page) throw new ApiError("Whatnot didn't return your Following list. Make sure you're signed in, then try again.");
        } catch (err) {
          // A refused first page may just mean the page size is too big.
          if (after === null && sizes.length > 1 && !err.retryable && !err.fatal) {
            sizes.shift();
            continue;
          }
          throw err;
        }
        for (const { node } of page.edges || []) {
          if (node && !seen.has(node.id)) {
            seen.add(node.id);
            follows.push(node);
          }
        }
        if (onProgress) onProgress(follows.length);
        const next = page.pageInfo && page.pageInfo.endCursor;
        if (!page.pageInfo || !page.pageInfo.hasNextPage || !next || next === after) return follows;
        after = next;
        await WUM.sleep(PAGE_PAUSE_MS);
      }
    },

    // Follow (active = true) or unfollow (active = false) one account.
    async setFollowing(id, active) {
      const data = await graphql('FollowUser', FOLLOW_USER, { id, active, followSource: 'USER_PROFILE_PAGE' });
      const result = data.followUser;
      if (!result || result.success === false) throw new ApiError('Whatnot did not accept the change.');
      if (result.user && result.user.isFollowing !== active) throw new ApiError('Whatnot reported no change.');
    },
  };
})();
