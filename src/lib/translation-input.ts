/** Preserve opaque cue IDs and source data; only structural errors abort a session. */
export function validateTranslationUnits(
  units: readonly { id: string; text: string }[],
  maxCharactersPerCaption: number,
) {
  if (units.length === 0) throw new Error('Choose at least one subtitle to translate.');
  const ids = new Set<string>();
  return units.map((unit) => {
    if (!unit || typeof unit.id !== 'string' || !unit.id.trim() || Array.from(unit.id).length > 256) {
      throw new Error('A subtitle has an invalid internal identity.');
    }
    if (ids.has(unit.id)) throw new Error('A subtitle was included more than once.');
    if (typeof unit.text !== 'string') throw new Error('Subtitle text must be a string.');
    if (Array.from(unit.text).length > maxCharactersPerCaption) {
      throw new Error('A subtitle exceeds the local translation session capacity.');
    }
    ids.add(unit.id);
    // Empty, control-bearing and ill-formed Unicode strings reach native validation,
    // which reports the affected cue without discarding other successful cues.
    return { id: unit.id, text: unit.text };
  });
}
