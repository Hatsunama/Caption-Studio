import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createProjectRecoveryCacheFileName,
  isCaptionStudioRecoveryCacheArtifact,
  isStaleCaptionStudioRecoveryCacheArtifact,
} from '../src/services/project-recovery-policy.ts';

test('recovery cache names are unique, human-readable, and narrowly owned', () => {
  const name = createProjectRecoveryCacheFileName('Birthday / beach!', 1_777_777_777_777, 'Ab_12$xyz');
  assert.equal(name, 'caption-studio-recovery-Birthday-beach-1777777777777-ab12xyz0.json');
  assert.equal(isCaptionStudioRecoveryCacheArtifact(name), true);
  assert.equal(isCaptionStudioRecoveryCacheArtifact('Birthday-beach-1777777777777.json'), true);
  assert.equal(isCaptionStudioRecoveryCacheArtifact('../caption-studio-recovery-project-1777777777777-ab12xyz0.json'), false);
  assert.equal(isCaptionStudioRecoveryCacheArtifact('unrelated.json'), false);
});

test('recovery cleanup uses exact metadata or its owned timestamp and ignores unrelated entries', () => {
  const nowMs = 2_000_000_000_000;
  const name = createProjectRecoveryCacheFileName('Project', nowMs, '12345678');
  const oldName = createProjectRecoveryCacheFileName('Project', nowMs - 25 * 60 * 60 * 1_000, '87654321');
  assert.equal(isStaleCaptionStudioRecoveryCacheArtifact(name, (nowMs - 25 * 60 * 60 * 1_000) / 1_000, nowMs), true);
  assert.equal(isStaleCaptionStudioRecoveryCacheArtifact(name, (nowMs - 23 * 60 * 60 * 1_000) / 1_000, nowMs), false);
  assert.equal(isStaleCaptionStudioRecoveryCacheArtifact(name, undefined, nowMs), false);
  assert.equal(isStaleCaptionStudioRecoveryCacheArtifact(oldName, undefined, nowMs), true);
  assert.equal(isStaleCaptionStudioRecoveryCacheArtifact('unrelated.json', 0, nowMs), false);
});

test('recovery sharing always enters owned cleanup and never returns a private cache URI', () => {
  const service = readFileSync(new URL('../src/services/project-recovery.ts', import.meta.url), 'utf8');
  assert.match(service, /try \{[\s\S]*Sharing\.shareAsync\(uri[\s\S]*\} finally \{[\s\S]*deleteOwnedRecoveryArtifact\(uri\)/);
  assert.doesNotMatch(service, /return uri/);
  assert.match(service, /Could not remove the temporary project recovery file/);
  assert.doesNotMatch(service, /else \{\s*throw cleanupError/);
  assert.match(service, /isStaleCaptionStudioRecoveryCacheArtifact/);
});
