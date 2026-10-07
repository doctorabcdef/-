const INTERVAL = 300;
const MINIMUM_GAP = 50;

export function createAutoRefresh({ refresh, getState, isVisible, isConnected,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let active = false, running = false, timer = null, followupDelay = null, failures = 0;
  const canRefresh = () => active && isVisible() && isConnected();

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function schedule(delay) {
    cancelTimer();
    if (!canRefresh()) return;
    timer = setTimer(() => { timer = null; void tick(); }, delay);
  }

  async function tick() {
    if (!canRefresh() || running) return;
    const state = getState();
    if (state.busy || state.refreshing) { schedule(INTERVAL); return; }
    const started = now();
    running = true;
    let failed = false;
    try {
      await refresh();
      failed = !getState().online;
    } catch {
      failed = true;
    } finally {
      running = false;
      if (!canRefresh()) { followupDelay = null; return; }
      if (followupDelay !== null) {
        const delay = followupDelay;
        followupDelay = null;
        schedule(delay);
      } else if (failed) {
        failures = Math.min(failures + 1, 5);
        schedule(Math.min(15000, 1000 * 2 ** (failures - 1)));
      } else {
        failures = 0;
        // Keep the cadence measured from request start, without overlapping GETs.
        schedule(Math.max(MINIMUM_GAP, INTERVAL - (now() - started)));
      }
    }
  }

  return {
    start() {
      if (active) return;
      active = true; failures = 0;
      if (running) followupDelay = INTERVAL;
      else schedule(INTERVAL);
    },
    wake() {
      active = true; failures = 0;
      cancelTimer();
      if (!canRefresh()) return;
      if (running) followupDelay = 0;
      else void tick();
    },
    stop() {
      active = false; failures = 0; followupDelay = null;
      cancelTimer();
    },
  };
}
