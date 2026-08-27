import { getDatabase } from '@/services/database';

export async function readPreference<T>(key: string, fallback: T): Promise<T> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ value_json: string }>(
    'SELECT value_json FROM preferences WHERE key = ?',
    key,
  );
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

export async function writePreference<T>(key: string, value: T): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(
    `INSERT INTO preferences (key, value_json) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    key,
    JSON.stringify(value),
  );
}
