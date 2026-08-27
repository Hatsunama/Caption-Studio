import CaptionMedia from 'caption-media';

import {
  collectLinkedMediaUris,
  unreferencedLinkedMediaUris,
} from '@/lib/media-lifecycle';
import {
  createMediaPermissionReleaseLedger,
  decodeMediaPermissionReleaseLedger,
  mergeMediaPermissionReleaseLedger,
  settleMediaPermissionReleaseAttempts,
  type MediaPermissionReleaseAttempt,
} from '@/lib/media-permission-release-ledger';
import { listProjectsStrict } from '@/services/database';
import { readPreference, writePreference } from '@/services/preferences';

export const linkedMediaUris = collectLinkedMediaUris;

const RELEASE_LEDGER_PREFERENCE = 'android-media-permission-release-ledger';
let releaseQueue: Promise<void> = Promise.resolve();
let volatilePending = createMediaPermissionReleaseLedger([]);

export async function releaseReadPermissions(uris: Iterable<string>) {
  await releaseUnreferencedReadPermissions(uris);
}

export async function releaseUnreferencedReadPermissions(uris: Iterable<string>) {
  const candidates = [...uris];
  const operation = releaseQueue
    .catch(() => undefined)
    .then(() => processPendingReadPermissionReleases(candidates));
  releaseQueue = operation;
  await operation;
}

export async function retryPendingReadPermissionReleases() {
  await releaseUnreferencedReadPermissions([]);
}

async function processPendingReadPermissionReleases(candidates: string[]) {
  let persisted = createMediaPermissionReleaseLedger([]);
  try {
    persisted = decodeMediaPermissionReleaseLedger(
      await readPreference<unknown>(RELEASE_LEDGER_PREFERENCE, persisted),
    );
  } catch (error) {
    console.warn('Could not read the Android media-access cleanup ledger.', error);
  }
  const pending = mergeMediaPermissionReleaseLedger(
    mergeMediaPermissionReleaseLedger(persisted, volatilePending.uris),
    candidates,
  );
  volatilePending = pending;
  if (pending.uris.length === 0) return;
  try {
    await writePreference(RELEASE_LEDGER_PREFERENCE, pending);
  } catch (error) {
    console.warn('Could not persist the Android media-access cleanup ledger; access was retained.', error);
    return;
  }
  let projects;
  try {
    projects = await listProjectsStrict();
  } catch (error) {
    console.warn('Could not verify whether Android media access is still in use; access was retained.', error);
    return;
  }
  const releasable = unreferencedLinkedMediaUris(pending.uris, projects);
  const results = await Promise.allSettled(
    releasable.map((uri) => Promise.resolve().then(() => CaptionMedia.releaseReadPermission(uri))),
  );
  const attempts: MediaPermissionReleaseAttempt[] = [];
  results.forEach((result, index) => {
    const uri = releasable[index];
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.name : 'Native release failure';
      console.warn(`Could not release Android media access for item ${index + 1}.`, reason);
      attempts.push({ uri, released: false });
      return;
    }
    attempts.push({ uri, released: result.value === true });
    if (result.value !== true) {
      console.warn(`Android retained media access for item ${index + 1}; cleanup remains queued.`);
    }
  });
  const remaining = settleMediaPermissionReleaseAttempts(pending, attempts);
  volatilePending = remaining;
  try {
    await writePreference(RELEASE_LEDGER_PREFERENCE, remaining);
  } catch (error) {
    volatilePending = pending;
    console.warn('Could not update the Android media-access cleanup ledger; cleanup remains queued.', error);
  }
}
