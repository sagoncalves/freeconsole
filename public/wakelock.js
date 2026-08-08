/**
 * Keeps the phone's screen awake while it is acting as a controller.
 *
 * A controller is the one kind of page a phone is sure to misread. The player is holding it,
 * looking at the TV, and tapping a button every few seconds - but the OS idle timer only
 * counts scrolls, keystrokes and taps on *interactive* chrome. It sees a still page and locks
 * the screen mid-game, which drops the socket and takes the player out of the round.
 *
 * The Screen Wake Lock API exists for exactly this, with one trap that makes the naive use of
 * it worse than useless: the browser RELEASES the lock whenever the document becomes hidden,
 * and never restores it. A single request() at startup therefore protects the first stretch
 * of play and nothing after the first lock, notification, or app switch - which looks like
 * the feature working intermittently rather than not working at all.
 *
 * So the lock is treated as something to be continuously re-asserted, not acquired once:
 * re-requested on every return to visibility, and on the sentinel's own release event.
 */

/** iOS shipped this in 16.4; older iPhones and every iOS browser before it have no API. */
export const wakeLockSupported = () =>
  typeof navigator !== "undefined" && "wakeLock" in navigator;

/**
 * Holds a screen wake lock for as long as the returned handle is alive.
 *
 * @param {(state: {active: boolean, reason: string}) => void} [onChange]
 *        Reports whether the screen is currently held awake, for diagnostics.
 * @returns {{ release: () => Promise<void>, isActive: () => boolean }}
 */
export function keepScreenAwake(onChange) {
  let sentinel = null;
  let stopped = false;
  let requesting = false;

  const report = (reason) => {
    const active = !!sentinel && !sentinel.released;
    try { window.__wakeLock = { active, reason, supported: wakeLockSupported() }; } catch {}
    if (onChange) onChange({ active, reason });
  };

  async function acquire(reason) {
    if (stopped || requesting) return;
    if (!wakeLockSupported()) { report("unsupported"); return; }
    // Requesting while hidden always rejects (NotAllowedError); wait for the return instead.
    if (document.visibilityState !== "visible") return;
    if (sentinel && !sentinel.released) return;

    requesting = true;
    try {
      sentinel = await navigator.wakeLock.request("screen");
      // Fires both when we release it and when the browser takes it back on hide. Re-asking
      // here is what makes the lock survive a lock/unlock cycle.
      sentinel.addEventListener("release", () => {
        report("released");
        // Only meaningful if we are still visible; otherwise visibilitychange covers it.
        if (!stopped && document.visibilityState === "visible") acquire("re-acquire");
      });
      report(reason);
    } catch {
      // Low battery, an OS power-saving mode, or a browser that gates it behind a gesture.
      // Never fatal: the game is perfectly playable, the screen just dims as it normally would.
      sentinel = null;
      report("denied");
    } finally {
      requesting = false;
    }
  }

  const onVisible = () => {
    if (document.visibilityState === "visible") acquire("visible");
  };

  document.addEventListener("visibilitychange", onVisible);
  // Safari/iOS restores a bfcached page without a visibilitychange, so the lock would stay
  // lost after a back-navigation or an app switch without this.
  window.addEventListener("pageshow", onVisible);
  // A returning phone is often still settling (rotation, keyboard dismissal) when the first
  // request lands; the OS can refuse it. One quiet retry costs nothing.
  window.addEventListener("focus", onVisible);

  acquire("initial");

  return {
    isActive: () => !!sentinel && !sentinel.released,
    async release() {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
      window.removeEventListener("focus", onVisible);
      try { if (sentinel && !sentinel.released) await sentinel.release(); } catch {}
      sentinel = null;
      report("stopped");
    },
  };
}
