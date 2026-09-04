// Stored source/track identities are bounded independently. A translation
// cue combines both, so its bound must include both components and the colon.
export const PROJECT_IDENTIFIER_MAX_LENGTH = 256;
export const TRANSLATION_CUE_IDENTIFIER_MAX_LENGTH = PROJECT_IDENTIFIER_MAX_LENGTH * 2 + 1;

const IDENTIFIER_CHARACTERS = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

export function isProjectIdentifier(value: unknown): value is string {
  return isIdentifier(value, PROJECT_IDENTIFIER_MAX_LENGTH);
}

export function isTranslationCueIdentifier(value: unknown): value is string {
  return isIdentifier(value, TRANSLATION_CUE_IDENTIFIER_MAX_LENGTH);
}

function isIdentifier(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string'
    && value.length <= maximumLength
    && IDENTIFIER_CHARACTERS.test(value);
}
