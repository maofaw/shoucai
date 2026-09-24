export const HARVEST_KEY = 'shoucai.lastHarvestFinishedAt';
export const UNDO_KEY = 'shoucai.harvestUndo';

export function pendingUndo(storage, now = Date.now()) {
  try {
    const record = JSON.parse(storage.getItem(UNDO_KEY));
    return record && record.expiresAt > now && storage.getItem(HARVEST_KEY) === record.current ? record : null;
  } catch { return null; }
}

export function recordHarvest(storage, at, now = Date.now()) {
  const date = new Date(at);
  if (!at || !Number.isFinite(date.getTime()) || date.getTime() > now) throw new Error('请选择有效且不晚于现在的完成时间。');
  const pending = pendingUndo(storage, now);
  const record = { previous: pending ? pending.previous : storage.getItem(HARVEST_KEY), current: date.toISOString(), expiresAt: now + 10_000 };
  storage.setItem(HARVEST_KEY, record.current);
  storage.setItem(UNDO_KEY, JSON.stringify(record));
  return record;
}

export function revertHarvest(storage, now = Date.now()) {
  const record = pendingUndo(storage, now);
  if (!record) throw new Error('撤销时间已过，可用“修改完成时间”修正。');
  if (record.previous) storage.setItem(HARVEST_KEY, record.previous);
  else storage.removeItem(HARVEST_KEY);
  storage.removeItem(UNDO_KEY);
  return record.previous;
}

// Cloud writes must arrive in the same order as local edits (including undo).
export function serialQueue() {
  let tail = Promise.resolve();
  return task => {
    const result = tail.catch(() => {}).then(task);
    tail = result;
    return result;
  };
}
