// Drop a call made while the previous one is still running; forget the flight
// when it settles, resolve or reject. WHY: Ekstrak awaits a lazy pdf-lib load
// and a whole export before it downloads, and its caller fires it on every tap,
// so an impatient second tap used to produce the same file twice.
export function singleFlight(fn) {
  let running = false;
  return async (...args) => {
    if (running) return undefined;
    running = true;
    try {
      return await fn(...args);
    } finally {
      running = false;
    }
  };
}
