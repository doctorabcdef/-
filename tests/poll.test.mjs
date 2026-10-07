import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoRefresh } from '../src/poll.js';

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fakeClock() {
  let time = 0, nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, delay) { const id = nextId++; timers.set(id, { at: time + delay, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    times: () => [...timers.values()].map(timer => timer.at).sort((a, b) => a - b),
    async advance(duration) {
      const end = time + duration;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        time = due[1].at; timers.delete(due[0]); due[1].fn();
        await settle();
      }
      time = end;
      await settle();
    },
  };
}
function setup(refresh, options = {}) {
  const clock = fakeClock(), state = { online: true, busy: false, refreshing: false };
  const availability = { visible: true, connected: true };
  const poll = createAutoRefresh({
    refresh: () => refresh({ clock, state }), getState: () => state,
    isVisible: () => availability.visible, isConnected: () => availability.connected,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...options,
  });
  return { poll, clock, state, availability };
}

test('start waits 300 ms; successful requests keep a 300 ms start-to-start cadence', async () => {
  const starts = [];
  const { poll, clock } = setup(({ clock }) => {
    starts.push(clock.now());
    return new Promise(resolve => clock.setTimer(resolve, 120));
  });
  poll.start(); poll.start();
  assert.deepEqual(clock.times(), [300]);
  await clock.advance(299); assert.deepEqual(starts, []);
  await clock.advance(1); assert.deepEqual(starts, [300]);
  await clock.advance(120); assert.deepEqual(clock.times(), [600]);
  await clock.advance(300); assert.deepEqual(starts, [300, 600]);
  assert.deepEqual(clock.times(), [900]);
  poll.stop(); assert.deepEqual(clock.times(), []);
});

test('slow requests stay serial and leave a 50 ms minimum gap after completion', async () => {
  const pending = deferred(), starts = [];
  const { poll, clock } = setup(({ clock }) => { starts.push(clock.now()); return pending.promise; });
  poll.start(); await clock.advance(1300);
  assert.deepEqual(starts, [300]); assert.deepEqual(clock.times(), []);
  pending.resolve(); await settle();
  assert.deepEqual(clock.times(), [1350]);
  await clock.advance(49); assert.deepEqual(starts, [300]);
  await clock.advance(1); assert.deepEqual(starts, [300, 1350]);
  poll.stop();
});

test('connection failures back off to 15 seconds and successful refresh resets the delay', async () => {
  const outcomes = [false, false, false, false, false, false, true, false], starts = [];
  const { poll, clock } = setup(async ({ clock, state }) => { starts.push(clock.now()); state.online = outcomes.shift(); });
  poll.start();
  for (const time of [300, 1300, 3300, 7300, 15300, 30300, 45300, 45600]) {
    assert.deepEqual(clock.times(), [time]);
    await clock.advance(time - clock.now());
  }
  assert.deepEqual(starts, [300, 1300, 3300, 7300, 15300, 30300, 45300, 45600]);
  assert.deepEqual(clock.times(), [46600]);
  poll.stop();
});

test('wake cancels a backed-off timer and resets the next failure to one second', async () => {
  let calls = 0;
  const { poll, clock } = setup(async ({ state }) => { calls++; state.online = false; });
  poll.start(); await clock.advance(1300);
  assert.equal(calls, 2); assert.deepEqual(clock.times(), [3300]);
  poll.wake(); await settle();
  assert.equal(calls, 3); assert.deepEqual(clock.times(), [2300]);
  poll.stop();
});

test('hidden and disconnected pages stop scheduling; wake refreshes immediately on return', async () => {
  let calls = 0;
  const { poll, clock, availability } = setup(async () => { calls++; });
  availability.visible = false; poll.start();
  await clock.advance(1000); assert.equal(calls, 0); assert.deepEqual(clock.times(), []);
  availability.visible = true; poll.wake(); await settle(); assert.equal(calls, 1);
  availability.visible = false; await clock.advance(300);
  assert.equal(calls, 1); assert.deepEqual(clock.times(), []);
  availability.visible = true; poll.wake(); await settle(); assert.equal(calls, 2);
  availability.connected = false; await clock.advance(300);
  assert.equal(calls, 2); assert.deepEqual(clock.times(), []);
  poll.wake(); await settle(); assert.equal(calls, 2);
  availability.connected = true; poll.wake(); await settle(); assert.equal(calls, 3);
  poll.stop(); await clock.advance(30000);
  assert.equal(calls, 3); assert.deepEqual(clock.times(), []);
});

test('writes and external refreshes postpone polling without starting competing requests', async () => {
  let calls = 0;
  const { poll, clock, state } = setup(async () => { calls++; });
  state.busy = true; poll.start(); await clock.advance(300);
  assert.equal(calls, 0); assert.deepEqual(clock.times(), [600]);
  state.busy = false; state.refreshing = true; await clock.advance(300);
  assert.equal(calls, 0); assert.deepEqual(clock.times(), [900]);
  state.refreshing = false; await clock.advance(300); assert.equal(calls, 1);
  poll.stop();
});

test('stop suppresses a pending completion; stop/wake and repeated wakes never overlap requests', async () => {
  const requests = [], starts = [];
  let inFlight = 0, maximumInFlight = 0;
  const { poll, clock } = setup(({ clock }) => {
    const request = deferred(); requests.push(request); starts.push(clock.now());
    maximumInFlight = Math.max(maximumInFlight, ++inFlight);
    return request.promise.finally(() => { inFlight--; });
  });
  poll.start(); poll.wake(); poll.wake(); poll.wake();
  assert.equal(requests.length, 1); assert.deepEqual(clock.times(), []);
  poll.stop(); requests[0].resolve(); await settle();
  assert.deepEqual(clock.times(), []);
  await clock.advance(1000); assert.equal(requests.length, 1);

  poll.wake(); assert.equal(requests.length, 2);
  poll.stop(); poll.wake(); poll.wake();
  assert.equal(requests.length, 2); assert.deepEqual(clock.times(), []);
  requests[1].resolve(); await settle();
  assert.deepEqual(clock.times(), [1000]);
  await clock.advance(0); assert.equal(requests.length, 3);
  assert.deepEqual(starts, [0, 1000, 1000]);
  assert.equal(maximumInFlight, 1);
  poll.stop(); requests[2].resolve(); await settle();
  assert.deepEqual(clock.times(), []);
});

test('a rejected refresh is handled and backed off', async () => {
  const { poll, clock } = setup(async () => { throw new Error('network request failed'); });
  poll.start(); await clock.advance(300);
  assert.deepEqual(clock.times(), [1300]);
  poll.stop();
});
