// Drop a call made while the previous one is still running; forget the flight
// when it settles, resolve or reject. WHY: Ekstrak awaits a lazy pdf-lib load
// and a whole export before it downloads, and its caller fires it on every tap,
// so an impatient second tap used to produce the same file twice.
//
// `onCall` fires on EVERY call, before the guard, including a call that is then
// dropped. WHY: the rail's tool_use event is documented as "the tap"; moving it
// inside the guarded body would narrow it to "a tap not made mid-flight", which
// is a changed field meaning (EXCLUDE 4). A throwing onCall never blocks the run.
export function singleFlight(fn, { onCall } = {}) {
  let running = false;
  return async (...args) => {
    if (onCall) {
      try { onCall(...args); } catch { /* a tap counter must never stop the action */ }
    }
    if (running) return undefined;
    running = true;
    try {
      return await fn(...args);
    } finally {
      running = false;
    }
  };
}
