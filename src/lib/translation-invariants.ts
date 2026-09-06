/** Accept invariant tokens, never an arbitrary echoed source sentence. */
export function isInvariantTranslation(source: string, translated: string, target: string): boolean {
  if (!translated) return false;
  const acknowledgement = (value: string) => value.toLowerCase().replace(/[\s\p{P}]/gu, '');
  if (['ok', 'okay'].includes(acknowledgement(source))) {
    const result = acknowledgement(translated);
    if (result === 'ok') return true;
    if (result === 'okay' && /^(en|es|fr|pt|id|de|tr|vi|it|pl)(-|$)/.test(target)) return true;
  }
  if (source !== translated) return false;
  return !/\p{L}/u.test(source) || /^https?:\/\/[^\s]+$/u.test(source);
}
