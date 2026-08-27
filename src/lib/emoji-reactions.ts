import reactionCatalogJson from '../../modules/caption-media/android/src/main/assets/emoji-reactions.json';

type ReactionCategory = {
  id: string;
  emojis: string[];
  keywords: string[];
};

type ReactionCatalog = {
  version: number;
  fallback: string[];
  categories: ReactionCategory[];
};

type PreparedKeyword = {
  normalized: string;
  semanticKey: string;
  compact: boolean;
};

type PreparedCategory = {
  category: ReactionCategory;
  keywords: PreparedKeyword[];
};

export type EmojiReactionWordContext = {
  words: readonly string[];
  activeIndex: number;
};

const reactionCatalog = reactionCatalogJson as ReactionCatalog;
validateCatalog(reactionCatalog);
const categoryById = new Map(reactionCatalog.categories.map((category) => [category.id, category]));
const preparedCategories: PreparedCategory[] = reactionCatalog.categories.map((category) => ({
  category,
  keywords: category.keywords.map((rawKeyword) => {
    const normalized = normalizeText(rawKeyword);
    return {
      normalized,
      semanticKey: semanticKey(normalized),
      compact: containsCompactScript(normalized),
    };
  }),
}));

export function reactionEmojis(
  activeWord: string,
  captionText = '',
  wordContext?: EmojiReactionWordContext,
): string[] {
  const active = normalizeText(activeWord);
  if (/^[$€£¥]?\d+(?:[.,]\d+)?%?$/u.test(active)) {
    const categoryId = /^[$€£¥]/u.test(active) ? 'money' : 'number';
    return categoryById.get(categoryId)!.emojis;
  }
  const direct = findCategory(active, wordContext);
  if (direct) return direct.emojis;
  if (!active && /[?？]/u.test(captionText)) {
    return categoryById.get('question')!.emojis;
  }
  return [];
}

function findCategory(text: string, wordContext?: EmojiReactionWordContext) {
  if (!text) return undefined;
  const tokens = latinTokens(text);
  if (!semanticKey(text) && tokens.length === 0) return undefined;
  const contextKeys = semanticContextKeys(text, wordContext);
  let bestMatch: { category: ReactionCategory; score: number } | undefined;

  preparedCategories.forEach(({ category, keywords }) => {
    keywords.forEach((keyword) => {
      let score = 0;
      if (keyword.compact) {
        if (keyword.semanticKey && contextKeys.has(keyword.semanticKey)) {
          score = 2_000 + codePointLength(keyword.semanticKey);
        }
      } else {
        const exact = tokens.includes(keyword.normalized);
        const inflected = !exact && tokens.some((token) => englishWordMatches(token, keyword.normalized));
        if (exact || inflected) {
          score = (exact ? 2_000 : 1_000) + codePointLength(keyword.normalized);
        }
      }

      if (score > (bestMatch?.score ?? 0)) {
        bestMatch = { category, score };
      }
    });
  });

  return bestMatch?.category;
}

function semanticContextKeys(activeText: string, wordContext?: EmojiReactionWordContext) {
  const contextWords = wordContext?.words;
  const requestedIndex = wordContext?.activeIndex ?? 0;
  const hasUsableContext =
    contextWords !== undefined
    && Number.isInteger(requestedIndex)
    && requestedIndex >= 0
    && requestedIndex < contextWords.length;
  const words = hasUsableContext ? contextWords : [activeText];
  const activeIndex = hasUsableContext ? requestedIndex : 0;
  const keys = new Set<string>();
  const firstIndex = Math.max(0, activeIndex - 5);
  const lastIndex = Math.min(words.length - 1, activeIndex + 5);

  for (let start = firstIndex; start <= activeIndex; start += 1) {
    let phrase = '';
    for (let end = start; end <= lastIndex && end - start < 6; end += 1) {
      phrase += words[end] ?? '';
      if (end >= activeIndex) {
        const key = semanticKey(phrase);
        if (key) keys.add(key);
      }
    }
  }

  const activeKey = semanticKey(activeText);
  if (activeKey) keys.add(activeKey);
  return keys;
}

function semanticKey(value: string) {
  return normalizeText(value).replace(/[^\p{L}\p{N}$€£¥]+/gu, '');
}

function codePointLength(value: string) {
  return Array.from(value).length;
}

function validateCatalog(catalog: ReactionCatalog) {
  if (catalog.version !== 1) throw new Error('Unsupported emoji reaction catalog');
  if (catalog.fallback.length < 6 || new Set(catalog.fallback).size !== catalog.fallback.length) {
    throw new Error('Emoji reaction fallback must contain at least six distinct emojis');
  }

  const categoryIds = new Set<string>();
  const familySignatures = new Set<string>();
  const keywordOwners = new Map<string, string>();
  catalog.categories.forEach((category) => {
    if (!category.id || categoryIds.has(category.id)) {
      throw new Error(`Invalid or duplicated emoji reaction category: ${category.id}`);
    }
    categoryIds.add(category.id);
    if (category.emojis.length < 6 || new Set(category.emojis).size !== category.emojis.length) {
      throw new Error(`Emoji reaction category ${category.id} must contain at least six distinct emojis`);
    }
    const signature = [...category.emojis].sort().join('\u0000');
    if (familySignatures.has(signature)) {
      throw new Error(`Emoji reaction category ${category.id} duplicates another reaction family`);
    }
    familySignatures.add(signature);
    category.keywords.forEach((rawKeyword) => {
      const keyword = normalizeText(rawKeyword);
      if (!keyword) throw new Error(`Emoji reaction category ${category.id} has an empty keyword`);
      const existingOwner = keywordOwners.get(keyword);
      if (existingOwner && existingOwner !== category.id) {
        throw new Error(`Emoji reaction keyword ${rawKeyword} belongs to both ${existingOwner} and ${category.id}`);
      }
      keywordOwners.set(keyword, category.id);
    });
  });

  ['money', 'number', 'question'].forEach((requiredId) => {
    if (!categoryIds.has(requiredId)) {
      throw new Error(`Emoji reaction catalog is missing required category ${requiredId}`);
    }
  });
}

function normalizeText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}'$€£¥?？.,%]+/gu, ' ').trim();
}

function latinTokens(value: string): string[] {
  return [...(value.match(/[\p{L}\p{N}'$€£¥]+/gu) ?? [])];
}

function containsCompactScript(value: string) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
}

function englishWordMatches(value: string, keyword: string) {
  const valueForms = englishWordForms(value);
  return englishWordForms(keyword).some((form) => valueForms.includes(form));
}

function englishWordForms(value: string) {
  if (!/^[a-z][a-z'-]{3,}$/u.test(value)) return [value];
  const forms = new Set([value]);
  if (value.endsWith('ies') && value.length > 4) forms.add(`${value.slice(0, -3)}y`);
  if (value.endsWith('ing') && value.length > 5) {
    let stem = value.slice(0, -3);
    const final = stem.at(-1);
    if (final && stem.at(-2) === final) stem = stem.slice(0, -1);
    forms.add(stem);
    forms.add(`${stem}e`);
  }
  if (value.endsWith('ed') && value.length > 4) {
    let stem = value.slice(0, -2);
    const final = stem.at(-1);
    if (final && stem.at(-2) === final) stem = stem.slice(0, -1);
    forms.add(stem);
    forms.add(`${stem}e`);
  }
  if (value.endsWith('es') && value.length > 4) forms.add(value.slice(0, -2));
  if (value.endsWith('s') && value.length > 3) forms.add(value.slice(0, -1));
  return [...forms];
}
