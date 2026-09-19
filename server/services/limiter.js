/** Caps how many transcription jobs run at once. Excess jobs are rejected, not queued. */
export function createLimiter(max) {
  let active = 0;
  return {
    /** Returns a release function, or null when the limit has been reached. */
    tryAcquire() {
      if (active >= max) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
    get active() {
      return active;
    },
  };
}
