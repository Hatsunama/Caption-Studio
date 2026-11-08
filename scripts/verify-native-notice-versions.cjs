'use strict';

const { readFileSync } = require('node:fs');
const metadata = require('../shared/native-notice-versions.json');
const COMPONENTS = [
  'org.jetbrains.kotlin:kotlin-reflect',
  'org.jetbrains.kotlinx:kotlinx-coroutines-android',
];
const CONCRETE_VERSION = /^\d+\.\d+\.\d+$/;

function parseSelectedVersions(report) {
  if (typeof report !== 'string') throw new Error('Runtime graph must be UTF-8 text');
  const selected = Object.fromEntries(COMPONENTS.map((id) => [id, new Set()]));
  for (const line of report.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
    // Only a component at the start of an ASCII dependency-tree line counts.
    // A caller's parenthesized "requested group:name:old" is not a selection.
    const component = /^[ |+\\-]*([^\s:]+:[^\s:]+):(.*)$/.exec(line);
    if (!component || !Object.hasOwn(selected, component[1])) continue;
    const [, id, tail] = component;
    const detail = /^(\S+?)(?: -> (\S+?))?((?: \([^()]*\))*) *$/.exec(tail);
    // Gradle constraints describe requests, not selected packaged components.
    if (detail && /\(c\)/.test(detail[3])) continue;
    const version = detail && (detail[2] ?? detail[1]);
    if (!version || !CONCRETE_VERSION.test(version) || /\(n\)/.test(detail[3])) {
      throw new Error(`Unknown actual version for ${id}: ${tail}`);
    }
    selected[id].add(version);
  }
  return Object.fromEntries(COMPONENTS.map((id) => {
    if (selected[id].size === 0) throw new Error(`Missing selected component: ${id}`);
    if (selected[id].size !== 1) throw new Error(`Ambiguous selected versions for ${id}: ${[...selected[id]].join(', ')}`);
    return [id, [...selected[id]][0]];
  }));
}

function verifyNativeNoticeVersions(report, expected = metadata) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)
      || Object.keys(expected).length !== COMPONENTS.length
      || COMPONENTS.some((id) => !Object.hasOwn(expected, id)
        || typeof expected[id] !== 'string' || !CONCRETE_VERSION.test(expected[id]))) {
    throw new Error('Invalid native notice version metadata');
  }
  const actual = parseSelectedVersions(report);
  for (const id of COMPONENTS) {
    if (actual[id] !== expected[id]) {
      throw new Error(`Native notice version mismatch for ${id}: notice=${expected[id]}, selected=${actual[id]}`);
    }
  }
  return actual;
}

module.exports = { parseSelectedVersions, verifyNativeNoticeVersions };

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-native-notice-versions.cjs <runtime-graph-path>');
    const actual = verifyNativeNoticeVersions(readFileSync(process.argv[2], 'utf8'));
    console.log(`Native notice versions verified: ${JSON.stringify(actual)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
