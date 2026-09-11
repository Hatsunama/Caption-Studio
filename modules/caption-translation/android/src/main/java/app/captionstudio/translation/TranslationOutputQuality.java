package app.captionstudio.translation;

import java.text.Normalizer;
import java.util.Locale;
import java.util.regex.Pattern;

/** Script screening cannot prove translation accuracy. Human edits remain authoritative. */
final class TranslationOutputQuality {
  private static final Pattern LETTER = Pattern.compile("\\p{L}");
  private static final Pattern HAN = Pattern.compile("\\p{IsHan}");
  private static final Pattern HIRAGANA_KATAKANA_HAN = Pattern.compile("[\\p{IsHiragana}\\p{IsKatakana}\\p{IsHan}]");
  private static final Pattern HANGUL = Pattern.compile("\\p{IsHangul}");
  private static final Pattern THAI = Pattern.compile("\\p{IsThai}");
  private static final Pattern ARABIC = Pattern.compile("\\p{IsArabic}");
  private static final Pattern DEVANAGARI = Pattern.compile("\\p{IsDevanagari}");
  private static final Pattern BENGALI = Pattern.compile("\\p{IsBengali}");
  private static final Pattern CYRILLIC = Pattern.compile("\\p{IsCyrillic}");
  private static final Pattern LATIN = Pattern.compile("\\p{IsLatin}");
  private static final Pattern ACKNOWLEDGEMENT_SEPARATORS = Pattern.compile("[\\s\\p{P}\\p{Z}]");
  private static final Pattern TRADITIONAL_ONLY = Pattern.compile("[們經這個來時會說為國學見點裡還對讓從開關過實體線話頭發無應長門車書買賣網電腦機與萬專業東兩樂習亂於雲親優傳傷倫餘兒黨蘭興養內寫軍農衝況凍刪則剛創劃劇劉動務勝勞勢區醫華協單衛廠廳壓縣參雙變葉號嘆嗎啟員問園圖圓聖場壞塊堅報聲處備復夠夢奪奮婦媽孫寧寶將層嶺島嶼帥師帳幀幣庫廢廣歸錄彙彈強當徑徹憶懷態總戀戰戶掃揚換據損搖攝擔擬擴擺擇擊數斷舊暫術樸權條極樣標樓檔檢歐歡歲殺殼毀氣漢湯溝滅灣濕準滾滿漁潔潛覽燈爐爭愛爺牆獨獲現環產畫異瘋療監盡盤碼禮種穩窩競筆築簡籤糧糾紀約紅級細終組結絕統綠維緊編緩練縮績繼續罷羅職聯聽肅腦腳脫臉臺艦藝節範薦藥虛蟲補裝規視覺訂計訊記討訓託設許論證評詞譯議讀豐貓貝負財責賬貨質購趕趨蹤軟轉輪輯輸辦辭邊遙郵鄉釋鐘鐵閃間隊陽陰陣階際陸險隨雜雞離難靈靜頁頂項順頓領頻題顏風飛飯館馬駕驗魚鳥黃齊龍]");
  private static final Pattern SIMPLIFIED_ONLY = Pattern.compile("[们经这个来时会说为国学见点里还对让从开关过实体线话头发无应长门车书买卖网电脑机与万专业东两乐习乱于云亲优传伤伦余儿党兰兴养内写军农冲况冻删则刚创划剧刘动务胜劳势区医华协单卫厂厅压县参双变叶号叹吗启员问园图圆圣场坏块坚报声处备复够梦夺奋妇妈孙宁宝将层岭岛屿帅师帐帧币库废广归录汇弹强当径彻忆怀态总恋战户扫扬换据损摇摄担拟扩摆择击数断旧暂术朴权条极样标楼档检欧欢岁杀壳毁气汉汤沟灭湾湿准滚满渔洁潜览灯炉争爱爷墙独获现环产画异疯疗监尽盘码礼种稳窝竞笔筑简签粮纠纪约红级细终组结绝统绿维紧编缓练缩绩继续罢罗职联听肃脑脚脱脸台舰艺节范荐药虚虫补装规视觉订计讯记讨训托设许论证评词译议读丰猫贝负财责账货质购赶趋踪软转轮辑输办辞边遥邮乡释钟铁闪间队阳阴阵阶际陆险随杂鸡离难灵静页顶项顺顿领频题颜风飞饭馆马驾验鱼鸟黄齐龙]");

  private TranslationOutputQuality() {}

  static boolean needsReview(String sourceText, String translatedText, String target) {
    String source = Normalizer.normalize(sourceText, Normalizer.Form.NFC).trim();
    String text = Normalizer.normalize(translatedText, Normalizer.Form.NFC).trim();
    if (text.isEmpty() || !isPlausibleCueTranslation(source, text)) return true;
    String sourceAck = acknowledgement(source);
    String targetAck = acknowledgement(text);
    if (sourceAck.equals("ok") || sourceAck.equals("okay")) {
      if (targetAck.equals("ok")) return false;
      if (targetAck.equals("okay") && target.matches("en|es|fr|pt|id|de|tr|vi|it|pl")) return false;
    }
    if (source.equals(text)) {
      if (!has(text, LETTER) || text.matches("https?://[^\\s]+")) return false;
      return true;
    }
    switch (target) {
      case "zh-Hans": return !has(text, HAN) || has(text, TRADITIONAL_ONLY);
      case "zh-Hant": return !has(text, HAN) || has(text, SIMPLIFIED_ONLY);
      case "ja": return !has(text, HIRAGANA_KATAKANA_HAN);
      case "ko": return !has(text, HANGUL);
      case "th": return !has(text, THAI);
      case "ar": case "ur": return !has(text, ARABIC);
      case "hi": return !has(text, DEVANAGARI);
      case "bn": return !has(text, BENGALI);
      case "ru": return !has(text, CYRILLIC);
      case "en": return has(text, HAN);
      default: return !has(text, LATIN);
    }
  }

  /**
   * Language-agnostic per-cue correspondence shared with JS translation-invariants.
   * Rejects multi-cue bleed / runaway expansion relative to that cue's source.
   */
  static boolean isPlausibleCueTranslation(String sourceText, String translatedText) {
    String source = Normalizer.normalize(sourceText, Normalizer.Form.NFC).trim();
    String translated = Normalizer.normalize(translatedText, Normalizer.Form.NFC).trim();
    if (translated.isEmpty()) return false;
    int sourcePoints = source.codePointCount(0, source.length());
    int translatedPoints = translated.codePointCount(0, translated.length());
    int maximum = Math.max(Math.max(sourcePoints * 4, sourcePoints + 60), 48);
    return translatedPoints <= maximum;
  }

  private static String acknowledgement(String text) {
    return ACKNOWLEDGEMENT_SEPARATORS.matcher(text.toLowerCase(Locale.ROOT)).replaceAll("");
  }

  private static boolean has(String text, Pattern pattern) {
    return pattern.matcher(text).find();
  }
}
