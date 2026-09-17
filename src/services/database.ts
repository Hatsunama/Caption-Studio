import * as SQLite from 'expo-sqlite';

import {
  createRetryableAsyncInitializer,
  decodeEveryPersistedRow,
  extractPersistedContentUris,
} from '@/lib/persistence-boundaries';
import { serializeProjectSnapshot } from '@/lib/project-schema';
import { decodePersistedProject } from '@/lib/project-codec';
import { applyProjectSourceThumbnail, projectLibraryProject } from '@/lib/project-library';
import type { CaptionProject } from '@/types/project';
import type { ProjectLibraryProject, ProjectRecordSummary } from '@/types/project-library';

const projectWriteQueues = new Map<string, Promise<void>>();
const deletedProjectIds = new Set<string>();

const initializeDatabaseOnce = createRetryableAsyncInitializer(initializeDatabase);

export function getDatabase() {
  return initializeDatabaseOnce();
}

async function initializeDatabase() {
  const database = await SQLite.openDatabaseAsync('caption-studio.db');
  try {
    await database.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        source_uri TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        project_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projects_updated_at
        ON projects(updated_at DESC);
      CREATE TABLE IF NOT EXISTS imported_fonts (
        id TEXT PRIMARY KEY NOT NULL,
        font_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL
      );
    `);
    await ensureProjectLibrarySchema(database);
    await backfillProjectLibraryMetadata(database);
    return database;
  } catch (error) {
    await database.closeAsync().catch(() => undefined);
    throw error;
  }
}

export async function saveProject(project: CaptionProject) {
  if (deletedProjectIds.has(project.id)) throw new Error('This project has been deleted.');
  const snapshot = serializeProjectSnapshot(project);
  const summary = projectLibraryProject(project);
  await enqueueProjectWrite(project.id, async () => {
    const database = await getDatabase();
    await database.runAsync(
      `INSERT INTO projects (
         id, name, source_uri, updated_at, project_json, created_at, source_id,
         thumbnail_uri, duration_ms, lifecycle_status, clip_count, caption_count, metadata_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         source_uri = excluded.source_uri,
         updated_at = excluded.updated_at,
         project_json = excluded.project_json,
         created_at = excluded.created_at,
         source_id = excluded.source_id,
         thumbnail_uri = excluded.thumbnail_uri,
         duration_ms = excluded.duration_ms,
         lifecycle_status = excluded.lifecycle_status,
         clip_count = excluded.clip_count,
         caption_count = excluded.caption_count,
         metadata_version = 1`,
      project.id,
      project.name,
      summary.sourceUri ?? '',
      project.updatedAt,
      snapshot,
      project.createdAt,
      summary.sourceId ?? null,
      summary.thumbnailUri ?? null,
      summary.durationMs,
      summary.lifecycleStatus,
      summary.clipCount,
      summary.captionCount,
    );
  });
}

export async function updateProjectSourceThumbnail(options: {
  projectId: string;
  sourceId: string;
  sourceUri: string;
  thumbnailUri: string;
}): Promise<ProjectLibraryProject | null> {
  if (deletedProjectIds.has(options.projectId)) return null;
  return enqueueProjectWrite(options.projectId, async () => {
    if (deletedProjectIds.has(options.projectId)) return null;
    const database = await getDatabase();
    let updated: ProjectLibraryProject | null = null;
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const row = await transaction.getFirstAsync<{ project_json: string }>(
        'SELECT project_json FROM projects WHERE id = ?',
        options.projectId,
      );
      if (!row) return;
      const project = decodePersistedProject(row.project_json);
      const prepared = applyProjectSourceThumbnail(
        project,
        options.sourceId,
        options.sourceUri,
        options.thumbnailUri,
      );
      if (!prepared) return;
      const summary = projectLibraryProject(prepared);
      await transaction.runAsync(
        `UPDATE projects SET
           project_json = ?, source_uri = ?, source_id = ?, thumbnail_uri = ?,
           duration_ms = ?, lifecycle_status = ?, clip_count = ?, caption_count = ?, metadata_version = 1
         WHERE id = ?`,
        serializeProjectSnapshot(prepared),
        summary.sourceUri ?? '',
        summary.sourceId ?? null,
        summary.thumbnailUri ?? null,
        summary.durationMs,
        summary.lifecycleStatus,
        summary.clipCount,
        summary.captionCount,
        options.projectId,
      );
      updated = summary;
    });
    return updated;
  });
}

export async function deleteProjectRecord(projectId: string): Promise<CaptionProject | null> {
  deletedProjectIds.add(projectId);
  await projectWriteQueues.get(projectId)?.catch(() => undefined);
  try {
    const database = await getDatabase();
    let deletedProject: CaptionProject | null = null;
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const row = await transaction.getFirstAsync<{ project_json: string }>(
        'SELECT project_json FROM projects WHERE id = ?',
        projectId,
      );
      deletedProject = row ? decodePersistedProject(row.project_json) : null;
      await transaction.runAsync('DELETE FROM projects WHERE id = ?', projectId);
    });
    return deletedProject;
  } catch (error) {
    deletedProjectIds.delete(projectId);
    throw error;
  }
}

export async function listProjectRecords(): Promise<ProjectRecordSummary[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<ProjectLibraryRow>(
    `SELECT id, name, source_uri, updated_at, created_at, source_id, thumbnail_uri,
            duration_ms, lifecycle_status, clip_count, caption_count, metadata_version
       FROM projects ORDER BY updated_at DESC`,
  );
  return rows.map((row) => row.metadata_version === 1
    ? {
        kind: 'project' as const,
        project: {
          id: row.id,
          name: row.name,
          createdAt: row.created_at ?? row.updated_at,
          updatedAt: row.updated_at,
          lifecycleStatus: row.lifecycle_status === 'draft' ? 'draft' : 'saved',
          sourceId: row.source_id ?? undefined,
          sourceUri: row.source_uri || undefined,
          thumbnailUri: row.thumbnail_uri ?? undefined,
          durationMs: Math.max(0, row.duration_ms ?? 0),
          clipCount: Math.max(0, row.clip_count ?? 0),
          captionCount: Math.max(0, row.caption_count ?? 0),
        },
      }
    : {
        kind: 'unreadable' as const,
        id: row.id,
        name: row.name || 'Unreadable project',
        updatedAt: row.updated_at,
        reason: 'The saved project data could not be read.',
      });
}

export async function listProjectsStrict(): Promise<CaptionProject[]> {
  return decodeEveryPersistedRow(await readProjectRows(), decodeProjectRow);
}

export async function listProjectRecordIds(): Promise<string[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{ id: string }>('SELECT id FROM projects');
  return rows.map((row) => row.id);
}

async function readProjectRows() {
  const database = await getDatabase();
  return database.getAllAsync<{ id: string; name: string; updated_at: string; project_json: string }>(
    'SELECT id, name, updated_at, project_json FROM projects ORDER BY updated_at DESC',
  );
}

function decodeProjectRow(row: { project_json: string }) {
  return decodePersistedProject(row.project_json);
}

async function enqueueProjectWrite<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectWriteQueues.get(projectId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  projectWriteQueues.set(projectId, tail);
  try {
    return await result;
  } finally {
    if (projectWriteQueues.get(projectId) === tail) projectWriteQueues.delete(projectId);
  }
}

type ProjectLibraryRow = {
  id: string;
  name: string;
  source_uri: string;
  updated_at: string;
  created_at: string | null;
  source_id: string | null;
  thumbnail_uri: string | null;
  duration_ms: number | null;
  lifecycle_status: string | null;
  clip_count: number | null;
  caption_count: number | null;
  metadata_version: number;
};

async function ensureProjectLibrarySchema(database: SQLite.SQLiteDatabase) {
  const columns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(projects)');
  const existing = new Set(columns.map((column) => column.name));
  const additions = [
    ['created_at', 'TEXT'],
    ['source_id', 'TEXT'],
    ['thumbnail_uri', 'TEXT'],
    ['duration_ms', 'INTEGER'],
    ['lifecycle_status', 'TEXT'],
    ['clip_count', 'INTEGER'],
    ['caption_count', 'INTEGER'],
    ['metadata_version', 'INTEGER NOT NULL DEFAULT 0'],
  ] as const;
  for (const [name, definition] of additions) {
    if (!existing.has(name)) await database.execAsync(`ALTER TABLE projects ADD COLUMN ${name} ${definition}`);
  }
}

async function backfillProjectLibraryMetadata(database: SQLite.SQLiteDatabase) {
  const rows = await database.getAllAsync<{ id: string; project_json: string; metadata_version: number }>(
    'SELECT id, project_json, metadata_version FROM projects WHERE metadata_version <> 1',
  );
  for (const row of rows) {
    try {
      const project = decodePersistedProject(row.project_json);
      const summary = projectLibraryProject(project);
      await database.runAsync(
        `UPDATE projects SET name = ?, source_uri = ?, updated_at = ?, created_at = ?, source_id = ?,
           thumbnail_uri = ?, duration_ms = ?, lifecycle_status = ?, clip_count = ?, caption_count = ?, metadata_version = 1
         WHERE id = ?`,
        project.name,
        summary.sourceUri ?? '',
        project.updatedAt,
        project.createdAt,
        summary.sourceId ?? null,
        summary.thumbnailUri ?? null,
        summary.durationMs,
        summary.lifecycleStatus,
        summary.clipCount,
        summary.captionCount,
        project.id,
      );
    } catch {
      await database.runAsync('UPDATE projects SET metadata_version = -1 WHERE id = ?', row.id);
    }
  }
}

export async function getRawProjectRecord(projectId: string): Promise<string | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ project_json: string }>(
    'SELECT project_json FROM projects WHERE id = ?',
    projectId,
  );
  return row?.project_json ?? null;
}

export async function deleteUnreadableProjectRecord(projectId: string) {
  deletedProjectIds.add(projectId);
  await projectWriteQueues.get(projectId)?.catch(() => undefined);
  try {
    const database = await getDatabase();
    let raw: string | null = null;
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const row = await transaction.getFirstAsync<{ project_json: string }>(
        'SELECT project_json FROM projects WHERE id = ?',
        projectId,
      );
      raw = row?.project_json ?? null;
      await transaction.runAsync('DELETE FROM projects WHERE id = ?', projectId);
    });
    return extractPersistedContentUris(raw);
  } catch (error) {
    deletedProjectIds.delete(projectId);
    throw error;
  }
}

export async function getProject(projectId: string): Promise<CaptionProject | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ project_json: string }>(
    'SELECT project_json FROM projects WHERE id = ?',
    projectId,
  );
  if (!row) return null;
  return decodePersistedProject(row.project_json);
}
