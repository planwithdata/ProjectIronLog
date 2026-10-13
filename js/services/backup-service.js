/** Bundled recovery snapshot. Existing records always win when recovering. */
import * as db from './db.js';

export const BUNDLED_BACKUP_URL = new URL('../../data/recovery-backup.json', import.meta.url);

function hasRecords(data) {
  return Object.values(data).some((value) => Array.isArray(value) && value.length > 0);
}

/** Seed an empty install; manual recovery also fills missing IDs without replacing edits. */
export async function restoreBundledBackup({ onlyIfEmpty = false } = {}) {
  const current = structuredClone(db.exportAll());
  const existing = hasRecords(current.data);
  const previousSessionCount = current.data.sessions.length;
  if (onlyIfEmpty && (existing || current.data.meta?.bundledRecoveryDismissed)) return null;

  const response = await fetch(BUNDLED_BACKUP_URL);
  if (!response.ok) throw new Error(`Recovery backup could not be loaded (HTTP ${response.status}).`);
  const backup = await response.json();
  if (backup.app !== 'Project IronLog' || !Array.isArray(backup.data?.sessions)
      || backup.schemaVersion !== db.SCHEMA_VERSION) {
    throw new Error('The bundled recovery backup is not compatible with this app.');
  }

  let payload = backup;
  if (existing) {
    // Keep settings, profile, edits and new logs. Only missing records are added.
    payload = current;
    for (const [collection, records] of Object.entries(backup.data)) {
      const saved = current.data[collection];
      if (!Array.isArray(records) || !Array.isArray(saved)) continue;
      const ids = new Set(saved.map((record) => record.id));
      const active = collection === db.COLLECTIONS.SESSIONS && saved.some((record) => record.status === 'in-progress');
      payload.data[collection] = [...saved, ...records.filter((record) =>
        record.id && !ids.has(record.id) && !(active && record.status === 'in-progress'))];
    }
  }
  const added = payload.data.sessions.length - previousSessionCount;
  await db.importAll(payload);
  return { added, total: db.read(db.COLLECTIONS.SESSIONS).length };
}
