const HOUR = 3_600_000;
export const CATCH_UP_DELAY = 30_000;
export const RETRY_DELAY = 15 * 60_000;
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
  const key = 'shoucai.scheduledCheck.v2';
  let timer, stopped = false, memory = null;
  const read = () => { try { return JSON.parse(storage.getItem(key)) ?? memory; } catch { return memory; } };
  const write = value => { memory = value; try { storage.setItem(key, JSON.stringify(value)); } catch {} };
  function arm() {
    if (stopped) return;
    const time = now(), slot = latestMarketSlot(time);
    const previous = read();
    const record = previous?.slot === slot ? previous : { slot, attempts: 0, lastAt: null, complete: false };
    const overdue = (Date.parse(generatedAt()) || 0) < slot && !record.complete && record.attempts < 3;
    const wait = overdue ? record.lastAt == null ? CATCH_UP_DELAY : Math.max(1, record.lastAt + RETRY_DELAY - time)
      : Math.max(1, nextMarketSlot(time) - time);
    timer = setTimer(async () => {
      if (stopped) return;
      const due = latestMarketSlot(now());
      if (isVisible() && (Date.parse(generatedAt()) || 0) < due) {
        const latest = read();
        const attempt = latest?.slot === due ? latest : { slot: due, attempts: 0, lastAt: null, complete: false };
        if (!attempt.complete && attempt.attempts < 3 && (attempt.lastAt == null || now() - attempt.lastAt >= RETRY_DELAY)) {
          const claimed = { ...attempt, attempts: attempt.attempts + 1, lastAt: now() };
          write(claimed);
          try {
            const result = await check();
            if (!result?.error && Math.max(Date.parse(result?.generatedAt) || 0, Date.parse(generatedAt()) || 0) >= due) write({ ...claimed, complete: true });
          } catch { /* Only the bounded retry above, or a manual refresh, will retry. */ }
        }
      }
      if (!isVisible()) timer = setTimer(arm, 60_000);
      else arm();
    }, wait);
  }
  arm();
  return () => { stopped = true; clearTimer(timer); };
}
