'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

// Project-local native repair, reviewed against the published npm 0.7.4 bytes.
// See docs/whisper-word-boundary-repair.md for provenance and native acceptance.
const BEFORE_SHA256 = '4eeac03d31372e34193f670394de19e625c87878743ca90d39da398c20ace4a6';
const AFTER_SHA256 = 'e6cd3b480140b6060af8fcd0da88e71babefb461399cdc0e91504149fff51b83';
const BEFORE = '        if (acc + cur > max_len && i > 0 && should_split_on_word(txt, split_on_word)) {';
const AFTER = '        if (acc + cur > max_len && i > 0 && should_split_on_word(txt, split_on_word) &&\n            token.t0 > segment.t0 && token.t0 < segment.t1) {';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function patchWhisperWordBoundaries(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot) throw Error('whisper repair requires an explicit project root');
  const modules = path.join(projectRoot, 'node_modules');
  try {
    fs.lstatSync(modules);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!fs.statSync(modules).isDirectory()) throw Error('Invalid node_modules directory');
  const packageRoot = path.join(modules, 'whisper.rn');
  const { version } = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (version !== '0.7.4') throw Error(`whisper repair refuses package version ${version}; requires 0.7.4`);
  const file = path.join(packageRoot, 'cpp', 'whisper.cpp');
  const before = fs.readFileSync(file);
  const hash = sha256(before);
  if (hash === AFTER_SHA256) return 'already-patched';
  if (hash !== BEFORE_SHA256) throw Error(`whisper repair refuses unknown whole-file SHA-256 ${hash}`);
  const after = before.toString('utf8').replace(BEFORE, AFTER);
  if (sha256(after) !== AFTER_SHA256) throw Error('whisper repair postimage SHA-256 mismatch');

  // Same-directory rename publishes the complete verified image atomically.
  // Failed writes/renames leave the original intact; retain temp files for review.
  const temporary = `${file}.caption-word-boundaries-${randomBytes(12).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, after, { encoding: 'utf8', flag: 'wx', mode: fs.statSync(file).mode });
  const currentVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
  if (currentVersion !== '0.7.4' || sha256(fs.readFileSync(file)) !== BEFORE_SHA256) {
    throw Error('whisper repair source/version changed before publication');
  }
  fs.renameSync(temporary, file);
  return 'patched';
}

module.exports = { patchWhisperWordBoundaries, BEFORE_SHA256, AFTER_SHA256 };
