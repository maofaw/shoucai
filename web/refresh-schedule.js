const HOUR = 3_600_000;
export const CATCH_UP_DELAY = 30_000;
// UTC+8 07:00 / 19:00, independent of the phone's timezone.
export function latestMarketSlot(now = Date.now()) {
  const local = new Date(now + 8 * HOUR);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 8 * HOUR;
  return now >= midnight + 19 * HOUR ? midnight + 19 * HOUR
    : now >= midnight + 7 * HOUR ? midnight + 7 * HOUR : midnight - 5 * HOUR;
}
export function nextMarketSlot(now = Date.now()) { return latestMarketSlot(now) + 12 * HOUR; }

export function scheduleMarketChecks({ check, generatedAt, storage, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, isVisible = () => true }) {
  const key = 'shoucai.lastScheduledSlot';
  let timer, stopped = false;
  const doneSlot = () => Math.max(Number(storage.getItem(key)) || 0, Date.parse(generatedAt()) || 0);
  function arm() {
    if (stopped) return;
    const time = now(), slot = latestMarketSlot(time);
    const overdue = doneSlot() < slot;
    timer = setTimer(async () => {
      if (stopped) return;
      const due = latestMarketSlot(now());
      if (isVisible() && doneSlot() < due) {
        storage.setItem(key, String(due));
        try { await check(); } catch { /* Manual retry remains available. */ }
      }
      if (!isVisible()) timer = setTimer(arm, 60_000);
      else arm();
    }, overdue ? CATCH_UP_DELAY : Math.max(1, nextMarketSlot(time) - time));
  }
  arm();
  return () => { stopped = true; clearTimer(timer); };
}
