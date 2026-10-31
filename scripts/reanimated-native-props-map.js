'use strict';

// Sparse source-map v3 splice: retain every original segment/name, shifting both
// generated JS and referenced TS lines. Insertions have no fabricated mappings.
// No source-map dependency or compiler regeneration (which would discard Babel's
// mappings) is needed for these pinned, insertion-only edits.
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decode(segment) {
  const values = [];
  let value = 0, shift = 0;
  for (const char of segment) {
    const digit = alphabet.indexOf(char);
    if (digit < 0 || shift > 30) throw Error('Invalid source-map VLQ');
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) { shift += 5; continue; }
    values.push(value & 1 ? -Math.floor(value / 2) : value / 2);
    value = 0; shift = 0;
  }
  if (shift) throw Error('Truncated source-map VLQ');
  return values;
}
function encode(values) {
  return values.map(number => {
    let value = Math.abs(number) * 2 + (number < 0 ? 1 : 0), result = '';
    do {
      const digit = value % 32;
      value = Math.floor(value / 32);
      result += alphabet[digit + (value ? 32 : 0)];
    } while (value);
    return result;
  }).join('');
}
const shifted = (line, insertions) => line + insertions.reduce((sum, [at, count]) => sum + (line >= at ? count : 0), 0);
function spliceMap(text, sourceInsertions, generatedInsertions, importLine) {
  const map = JSON.parse(text);
  if (map.version !== 3 || map.sourceRoot !== '../../../src' ||
      JSON.stringify(map.sources) !== '["platformFunctions/setNativeProps.ts"]' ||
      Object.hasOwn(map, 'sourcesContent')) throw Error('Unexpected pinned source-map metadata');
  let source = 0, sourceLine = 0, sourceColumn = 0, name = 0;
  const lines = [];
  for (const [line, encoded] of map.mappings.split(';').entries()) {
    let column = 0;
    const segments = encoded ? encoded.split(',').map(segment => {
      const v = decode(segment);
      if (![1, 4, 5].includes(v.length)) throw Error('Invalid source-map segment');
      column += v[0];
      const absolute = [column];
      if (v.length > 1) {
        source += v[1]; sourceLine += v[2]; sourceColumn += v[3];
        absolute.push(source, shifted(sourceLine, sourceInsertions), sourceColumn);
        if (v.length === 5) { name += v[4]; absolute.push(name); }
      }
      // Inserting "IS_ANDROID, " after "import { ". Explicitly terminate
      // the preceding mapping at the new identifier; resume original tokens.
      if (line === importLine && column >= 9) absolute[0] += 12;
      return absolute;
    }) : [];
    if (line === importLine) segments.push([9]);
    segments.sort((a, b) => a[0] - b[0]);
    lines[shifted(line, generatedInsertions)] = segments;
  }
  source = 0; sourceLine = 0; sourceColumn = 0; name = 0;
  map.mappings = Array.from({length:lines.length}, (_, index) => {
    let column = 0;
    return (lines[index] || []).map(v => {
      const delta = [v[0] - column]; column = v[0];
      if (v.length > 1) {
        delta.push(v[1] - source, v[2] - sourceLine, v[3] - sourceColumn);
        [source, sourceLine, sourceColumn] = v.slice(1, 4);
        if (v.length === 5) { delta.push(v[4] - name); name = v[4]; }
      }
      return encode(delta);
    }).join(',');
  }).join(';');
  return JSON.stringify(map);
}
module.exports = { spliceMap };
