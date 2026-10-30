// Bulk runner: follows or unfollows a queue of accounts one at a time, with
// a randomized pause between accounts. Backs off when Whatnot rate-limits,
// halts on fatal errors or a streak of failures, and can be paused, resumed
// or stopped at any point.
(() => {
  'use strict';
  const WUM = globalThis.WUM;

  // Pause between two accounts. Randomized within the range so the traffic
  // isn't machine-regular.
  WUM.SPEEDS = {
    careful: { label: 'Careful', hint: 'about 3 seconds per account', min: 2500, max: 4000 },
    normal: { label: 'Normal', hint: 'about 1.6 seconds per account', min: 1200, max: 2000 },
    fast: { label: 'Fast', hint: 'about 0.8 seconds per account', min: 600, max: 1000 },
  };

  // Rough time one request takes, for time estimates.
  const REQUEST_MS = 400;

  // Waits before retrying an account after a rate limit or server error.
  const BACKOFF_MS = [30000, 60000, 120000];
  const MAX_FAILURES_IN_A_ROW = 5;

  WUM.estimateMs = (count, speed) => {
    const pace = WUM.SPEEDS[speed] || WUM.SPEEDS.normal;
    return count * ((pace.min + pace.max) / 2 + REQUEST_MS);
  };

  // status: running | paused | waiting (backing off) | done | stopped | halted
  WUM.createRunner = ({ accounts, follow, speed, skip = () => false, onUpdate }) => {
    const pace = WUM.SPEEDS[speed] || WUM.SPEEDS.normal;
    const state = {
      total: accounts.length,
      index: 0,
      succeeded: [],
      failed: [], // { user, error }
      skipped: [],
      status: 'running',
      message: '',
    };
    let paused = false;
    let stopped = false;
    let wake = null;

    const emit = () => onUpdate({ ...state });

    // A sleep that pause() and stop() can cut short.
    const nap = (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          wake = null;
          resolve();
        }
        wake = done;
      });

    // Resolves to { ok, error }, or { deferred } when paused or stopped
    // during a back-off wait. Throws only for fatal errors.
    async function processOne(user) {
      for (let attempt = 0; ; attempt++) {
        try {
          await WUM.api.setFollowing(user.id, follow);
          return { ok: true };
        } catch (err) {
          if (err.fatal) throw err;
          if (!err.retryable || attempt >= BACKOFF_MS.length) return { ok: false, error: err.message };
          const wait = Math.max(BACKOFF_MS[attempt], err.retryAfterMs || 0);
          state.status = 'waiting';
          state.message = `${err.message} Trying again in ${Math.round(wait / 1000)} seconds.`;
          emit();
          await nap(wait);
          if (stopped || paused) return { deferred: true };
          state.status = 'running';
          state.message = '';
          emit();
        }
      }
    }

    async function run() {
      emit();
      let failuresInARow = 0;
      while (state.index < accounts.length && !stopped) {
        while (paused && !stopped) await nap(250);
        if (stopped) break;

        const user = accounts[state.index];
        if (skip(user)) {
          state.skipped.push(user);
          state.index++;
          emit();
          continue;
        }

        let result;
        try {
          result = await processOne(user);
        } catch (err) {
          state.status = 'halted';
          state.message = err.message;
          emit();
          return state;
        }
        if (result.deferred) continue; // this account is tried again on resume

        state.index++;
        if (result.ok) {
          state.succeeded.push(user);
          failuresInARow = 0;
        } else {
          state.failed.push({ user, error: result.error });
          failuresInARow++;
        }
        emit();

        if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
          state.status = 'halted';
          state.message = `Stopped after ${MAX_FAILURES_IN_A_ROW} failures in a row. Last error: ${result.error}`;
          emit();
          return state;
        }
        if (state.index < accounts.length && !stopped && !paused) await nap(WUM.randomBetween(pace.min, pace.max));
      }
      state.status = stopped ? 'stopped' : 'done';
      state.message = '';
      emit();
      return state;
    }

    return {
      start: run,
      pause() {
        if (state.status !== 'running' && state.status !== 'waiting') return;
        paused = true;
        state.status = 'paused';
        state.message = '';
        if (wake) wake();
        emit();
      },
      resume() {
        if (!paused) return;
        paused = false;
        state.status = 'running';
        if (wake) wake();
        emit();
      },
      stop() {
        stopped = true;
        paused = false;
        if (wake) wake();
      },
    };
  };
})();
