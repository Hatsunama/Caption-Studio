import { isInvariantTranslation } from '@/lib/translation-invariants';

export type EnglishChineseCaptionLanguage = 'en' | 'zh-Hans' | 'zh-Hant';

export type CaptionLanguageTag =
  | 'en'
  | 'zh-Hans'
  | 'zh-Hant'
  | 'hi'
  | 'es'
  | 'fr'
  | 'ar'
  | 'bn'
  | 'pt'
  | 'ru'
  | 'id'
  | 'de'
  | 'ja'
  | 'ko'
  | 'tr'
  | 'vi'
  | 'th'
  | 'it'
  | 'pl';

export type CaptionGroupingProfile = 'spaced' | 'cjk' | 'hangul' | 'thai' | 'arabic';

export type CaptionLanguageDefinition = {
  tag: CaptionLanguageTag;
  displayName: string;
  family: string;
  grouping: CaptionGroupingProfile;
  automaticTranslation: boolean;
};

export const TOP_SPOKEN_CAPTION_LANGUAGES: readonly CaptionLanguageDefinition[] = [
  { tag: 'en', displayName: 'English', family: 'en', grouping: 'spaced', automaticTranslation: true },
  { tag: 'zh-Hans', displayName: 'Chinese (Simplified)', family: 'zh', grouping: 'cjk', automaticTranslation: true },
  { tag: 'zh-Hant', displayName: 'Chinese (Traditional)', family: 'zh', grouping: 'cjk', automaticTranslation: true },
  { tag: 'hi', displayName: 'Hindi', family: 'hi', grouping: 'spaced', automaticTranslation: true },
  { tag: 'es', displayName: 'Spanish', family: 'es', grouping: 'spaced', automaticTranslation: true },
  { tag: 'fr', displayName: 'French', family: 'fr', grouping: 'spaced', automaticTranslation: true },
  { tag: 'ar', displayName: 'Arabic', family: 'ar', grouping: 'arabic', automaticTranslation: true },
  { tag: 'bn', displayName: 'Bengali', family: 'bn', grouping: 'spaced', automaticTranslation: true },
  { tag: 'pt', displayName: 'Portuguese', family: 'pt', grouping: 'spaced', automaticTranslation: true },
  { tag: 'ru', displayName: 'Russian', family: 'ru', grouping: 'spaced', automaticTranslation: true },
  { tag: 'id', displayName: 'Indonesian', family: 'id', grouping: 'spaced', automaticTranslation: true },
  { tag: 'de', displayName: 'German', family: 'de', grouping: 'spaced', automaticTranslation: true },
  { tag: 'ja', displayName: 'Japanese', family: 'ja', grouping: 'cjk', automaticTranslation: true },
  { tag: 'ko', displayName: 'Korean', family: 'ko', grouping: 'hangul', automaticTranslation: true },
  { tag: 'tr', displayName: 'Turkish', family: 'tr', grouping: 'spaced', automaticTranslation: true },
  { tag: 'vi', displayName: 'Vietnamese', family: 'vi', grouping: 'spaced', automaticTranslation: true },
  { tag: 'th', displayName: 'Thai', family: 'th', grouping: 'thai', automaticTranslation: true },
  { tag: 'it', displayName: 'Italian', family: 'it', grouping: 'spaced', automaticTranslation: true },
  { tag: 'pl', displayName: 'Polish', family: 'pl', grouping: 'spaced', automaticTranslation: true },
];

const LANGUAGE_BY_TAG = new Map(TOP_SPOKEN_CAPTION_LANGUAGES.map((language) => [language.tag, language]));

export function captionLanguageFamily(languageTag: string) {
  return resolveCaptionLanguage(languageTag)?.family ?? languageTag.trim().toLowerCase().split('-')[0] ?? '';
}

export function sameCaptionLanguageFamily(left: string, right: string) {
  return captionLanguageFamily(left) === captionLanguageFamily(right);
}

export function captionLanguageLabel(languageTag: string) {
  return resolveCaptionLanguage(languageTag)?.displayName ?? languageTag.trim();
}

export function captionGroupingProfile(languageTag: string): CaptionGroupingProfile {
  return resolveCaptionLanguage(languageTag)?.grouping ?? inferGroupingProfile(languageTag);
}

export type DualCaptionLanguageChoice = {
  tag: CaptionLanguageTag;
  displayName: string;
  automatic: boolean;
};

export function canonicalCaptionLanguageTag(languageTag: string) {
  const resolved = resolveCaptionLanguage(languageTag);
  if (resolved) return resolved.tag;
  const trimmed = languageTag.trim();
  if (!trimmed) throw new Error('Caption language is missing.');
  return trimmed;
}

export function supportsAutomaticCaptionTranslation(languageTag: string) {
  return resolveCaptionLanguage(languageTag)?.automaticTranslation === true;
}

export function canAutomaticallyTranslatePair(sourceLanguageTag: string, targetLanguageTag: string) {
  const source = resolveCaptionLanguage(sourceLanguageTag);
  const target = resolveCaptionLanguage(targetLanguageTag);
  return Boolean(source && target && source.family !== target.family
    && source.automaticTranslation && target.automaticTranslation);
}

export function automaticTranslationTargetTags(sourceLanguageTag: string): CaptionLanguageTag[] {
  const source = resolveCaptionLanguage(sourceLanguageTag);
  if (!source) throw new Error('Caption Studio cannot translate an unknown source language.');
  return TOP_SPOKEN_CAPTION_LANGUAGES
    .filter((language) => language.automaticTranslation && language.family !== source.family)
    .map((language) => language.tag);
}

export function dualCaptionLanguageChoices(sourceLanguageTag: string): DualCaptionLanguageChoice[] {
  const sourceFamily = captionLanguageFamily(sourceLanguageTag);
  return TOP_SPOKEN_CAPTION_LANGUAGES
    .filter((language) => language.family !== sourceFamily)
    .map((language) => ({
      tag: language.tag,
      displayName: language.displayName,
      automatic: canAutomaticallyTranslatePair(sourceLanguageTag, language.tag),
    }));
}

export function resolveCaptionLanguage(languageTag: string): CaptionLanguageDefinition | undefined {
  const normalized = languageTag.trim().toLowerCase();
  if (!normalized) return undefined;
  if (LANGUAGE_BY_TAG.has(normalized as CaptionLanguageTag)) {
    return LANGUAGE_BY_TAG.get(normalized as CaptionLanguageTag);
  }
  try {
    const englishChinese = normalizeEnglishChineseCaptionLanguage(normalized);
    return LANGUAGE_BY_TAG.get(englishChinese);
  } catch {
    const family = normalized.split('-')[0] ?? '';
    return TOP_SPOKEN_CAPTION_LANGUAGES.find((language) => language.family === family);
  }
}

export function normalizeEnglishChineseCaptionLanguage(languageTag: string): EnglishChineseCaptionLanguage {
  const normalized = languageTag.trim().toLowerCase();
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  if (normalized === 'zh-hant' || normalized.startsWith('zh-hant-') || normalized === 'zh-tw' || normalized === 'zh-hk' || normalized === 'yue') {
    return 'zh-Hant';
  }
  if (normalized === 'zh' || normalized === 'zh-hans' || normalized.startsWith('zh-hans-') || normalized === 'zh-cn' || normalized === 'zh-sg') {
    return 'zh-Hans';
  }
  throw new Error('On-device translation currently supports English and Chinese captions.');
}

// Keep these variant markers aligned with native TranslationOutputQuality.
const TRADITIONAL_ONLY = /[們經這個來時會說為國學見點裡還對讓從開關過實體線話頭發無應長門車書買賣網電腦機與萬專業東兩樂習亂於雲親優傳傷倫餘兒黨蘭興養內寫軍農衝況凍刪則剛創劃劇劉動務勝勞勢區醫華協單衛廠廳壓縣參雙變葉號嘆嗎啟員問園圖圓聖場壞塊堅報聲處備復夠夢奪奮婦媽孫寧寶將層嶺島嶼帥師帳幀幣庫廢廣歸錄彙彈強當徑徹憶懷態總戀戰戶掃揚換據損搖攝擔擬擴擺擇擊數斷舊暫術樸權條極樣標樓檔檢歐歡歲殺殼毀氣漢湯溝滅灣濕準滾滿漁潔潛覽燈爐爭愛爺牆獨獲現環產畫異瘋療監盡盤碼禮種穩窩競筆築簡籤糧糾紀約紅級細終組結絕統綠維緊編緩練縮績繼續罷羅職聯聽肅腦腳脫臉臺艦藝節範薦藥虛蟲補裝規視覺訂計訊記討訓託設許論證評詞譯議讀豐貓貝負財責賬貨質購趕趨蹤軟轉輪輯輸辦辭邊遙郵鄉釋鐘鐵閃間隊陽陰陣階際陸險隨雜雞離難靈靜頁頂項順頓領頻題顏風飛飯館馬駕驗魚鳥黃齊龍]/u;
const SIMPLIFIED_ONLY = /[们经这个来时会说为国学见点还对让从开关过实体线话头发无应长门车书买卖网电脑机与万专业东两乐习乱于云亲优传伤伦余儿党兰兴养内写军农冲况冻删则刚创划剧刘动务胜劳势区医华协单卫厂厅压县参双变叶号叹吗启员问园图圆圣场坏块坚报声处备复够梦夺奋妇妈孙宁宝将层岭岛屿帅师帐帧币库废广归录汇弹强当径彻忆怀态总恋战户扫扬换据损摇摄担拟扩摆择击数断旧暂术朴权条极样标楼档检欧欢岁杀壳毁气汉汤沟灭湾湿准滚满渔洁潜览灯炉争爱爷墙独获现环产画异疯疗监尽盘码礼种稳窝竞笔筑简签粮纠纪约红级细终组结绝统绿维紧编缓练缩绩继续罢罗职联听肃脑脚脱脸舰艺节范荐药虚虫补装规视觉订计讯记讨训托设许论证评词译议读丰猫贝负财责账货质购赶趋踪软转轮辑输办辞边遥邮乡释钟铁闪间队阳阴阵阶际陆险随杂鸡离难灵静页顶项顺顿领频题颜风飞饭馆马驾验鱼鸟黄齐龙]/u;

function translationEchoKey(text: string) {
  return text.toLowerCase().replace(/[\s\p{P}\p{Z}]+/gu, ' ').trim();
}

export function isLikelyUntranslatedCaption(sourceText: string, translatedText: string, targetLanguage: string) {
  const source = sourceText.normalize('NFC').trim();
  const translated = translatedText.normalize('NFC').trim();
  if (isInvariantTranslation(source, translated, targetLanguage)) return false;
  if (!translated || source === translated) return true;
  if (/\p{L}/u.test(source) && translationEchoKey(source) === translationEchoKey(translated)) return true;
  // A whole-cue borrowed acknowledgement cannot stand in for a longer source.
  if (Array.from(source).length > 20 && /^[\s\p{P}\p{Z}]*(?:ok|okay|o\.k\.)[\s\p{P}\p{Z}]*$/iu.test(translated)) return true;
  const multilingualTarget = resolveCaptionLanguage(targetLanguage)?.tag;
  if (multilingualTarget && multilingualTarget !== 'en' && multilingualTarget !== 'zh-Hans' && multilingualTarget !== 'zh-Hant') {
    if (multilingualTarget === 'ja') return !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(translated);
    if (multilingualTarget === 'ko') return !/\p{Script=Hangul}/u.test(translated);
    if (multilingualTarget === 'th') return !/\p{Script=Thai}/u.test(translated);
    if (multilingualTarget === 'ar') return !/\p{Script=Arabic}/u.test(translated);
    if (multilingualTarget === 'hi') return !/\p{Script=Devanagari}/u.test(translated);
    if (multilingualTarget === 'bn') return !/\p{Script=Bengali}/u.test(translated);
    if (multilingualTarget === 'ru') return !/\p{Script=Cyrillic}/u.test(translated);
    return !/\p{Script=Latin}/u.test(translated);
  }
  try {
    const target = normalizeEnglishChineseCaptionLanguage(targetLanguage);
    if (target === 'en') return !/\p{Script=Latin}/u.test(translated) || containsChineseCaptionText(translated);
    return !containsChineseCaptionText(translated)
      || (target === 'zh-Hans' ? TRADITIONAL_ONLY : SIMPLIFIED_ONLY).test(translated);
  } catch {
    return false;
  }
}

function containsChineseCaptionText(value: string) {
  return /\p{Script=Han}/u.test(value);
}

function inferGroupingProfile(languageTag: string): CaptionGroupingProfile {
  const family = languageTag.trim().toLowerCase().split('-')[0] ?? '';
  if (family === 'zh' || family === 'ja' || family === 'yue') return 'cjk';
  if (family === 'ko') return 'hangul';
  if (family === 'th' || family === 'lo' || family === 'km' || family === 'my') return 'thai';
  if (family === 'ar' || family === 'ur' || family === 'fa' || family === 'ps') return 'arabic';
  return 'spaced';
}
