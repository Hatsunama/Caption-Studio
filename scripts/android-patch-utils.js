const fs = require('node:fs');

function readRequired(file) {
  if (!fs.existsSync(file)) throw new Error(`Required Android build input is missing: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

function writeIfChanged(file, source, next) {
  if (next !== source) fs.writeFileSync(file, next);
  return next !== source;
}

function replaceKnown(file, from, to) {
  if (!fs.existsSync(file)) return false;
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes(from) && !source.includes(to)) {
    throw new Error(`Android build input changed unexpectedly: ${file}`);
  }
  return writeIfChanged(file, source, source.replaceAll(from, to));
}

function replaceOptional(file, from, to) {
  if (!fs.existsSync(file)) return false;
  const source = fs.readFileSync(file, 'utf8');
  return writeIfChanged(file, source, source.replaceAll(from, to));
}

function appendLineIfMissing(file, line) {
  const source = readRequired(file);
  if (source.split(/\r?\n/).includes(line)) return false;
  fs.writeFileSync(file, `${source.trimEnd()}\n\n${line}\n`);
  return true;
}

function insertAfterRequired(file, anchor, line) {
  const source = readRequired(file);
  if (source.includes(line)) return false;
  if (!source.includes(anchor)) {
    throw new Error(`Required Android build anchor is missing from ${file}: ${anchor}`);
  }
  return writeIfChanged(file, source, source.replace(anchor, `${anchor}\n${line}`));
}

function replaceLineRequired(file, pattern, replacement) {
  const source = readRequired(file);
  if (!pattern.test(source)) {
    throw new Error(`Required Android build setting is missing from ${file}: ${pattern}`);
  }
  return writeIfChanged(file, source, source.replace(pattern, replacement));
}

function modernizeGroovyAssignments(file) {
  if (!fs.existsSync(file)) return false;
  const source = fs.readFileSync(file, 'utf8');
  let next = source;
  for (const property of [
    'abortOnError',
    'buildConfig',
    'canBePublished',
    'compose',
    'crunchPngs',
    'ignoreAssetsPattern',
    'ndkVersion',
    'namespace',
    'prefab',
    'shrinkResources',
    'signingConfig',
    'useLegacyPackaging',
  ]) {
    next = next.replace(
      new RegExp(`^(\\s*)${property}\\s+(?![=])(.+)$`, 'gm'),
      `$1${property} = $2`,
    );
  }
  next = next
    .replace(/maven \{ url (['"][^'"]+['"]) \}/g, 'maven { url = uri($1) }')
    .replace(/^(\s*)url\s+(['"][^'"]+['"])$/gm, '$1url = uri($2)');
  return writeIfChanged(file, source, next);
}

function findNamedBlockRange(source, name, purpose = name) {
  const match = new RegExp(`\\b${escapeRegExp(name)}\\s*\\{`).exec(source);
  if (!match) throw new Error(`Android build input is missing ${purpose}.`);
  const openingBrace = source.indexOf('{', match.index);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return { start: match.index, end: index + 1 };
  }
  throw new Error(`Android build input has an unterminated ${purpose} block.`);
}

function replaceRange(source, range, replacement) {
  return `${source.slice(0, range.start)}${replacement}${source.slice(range.end)}`;
}

function assertContains(file, expected, purpose) {
  const source = readRequired(file);
  if (!source.includes(expected)) throw new Error(`${file} is missing ${purpose}.`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  appendLineIfMissing,
  assertContains,
  findNamedBlockRange,
  insertAfterRequired,
  modernizeGroovyAssignments,
  readRequired,
  replaceKnown,
  replaceLineRequired,
  replaceOptional,
  replaceRange,
  writeIfChanged,
};
