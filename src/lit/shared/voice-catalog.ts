import { UI_LOCALES, type JsonRecord } from "./catalog";

const COPY: Record<string, readonly string[]> = {
  all: ["すべて", "All voices", "全部語音", "全部语音", "전체 음성"],
  daily: ["日常", "Daily life", "日常", "日常", "일상"],
  growth: ["育成", "Growth", "養成", "养成", "육성"],
  gacha: ["メンバー獲得", "Recruitment", "成員招募", "成员招募", "멤버 모집"],
  live: ["ライブ", "Performance", "演出", "演出", "라이브"],
  interaction: ["掛け合い", "Interactions", "互動對話", "互动对话", "상호 대사"],
  other: ["その他", "Other voices", "其他語音", "其他语音", "기타 음성"],
  category: ["カテゴリー", "Voice category", "語音類別", "语音类别", "음성 분류"],
  search: [
    "セリフ・相手を検索",
    "Search dialogue or partner",
    "搜尋台詞或互動角色",
    "搜索台词或互动角色",
    "대사 또는 상대 검색",
  ],
  sequential: ["順番に再生", "Play in order", "依序播放", "顺序播放", "순서대로 재생"],
  unavailable: ["音源未収録", "Audio unavailable", "暫無音源", "暂无音源", "음원 없음"],
  noText: ["セリフ未収録", "Transcript unavailable", "暫無台詞文本", "暂无台词文本", "대사 정보 없음"],
  failure: [
    "再生できませんでした。もう一度お試しください。",
    "Playback failed. Try again.",
    "播放失敗，請重試。",
    "播放失败，请重试。",
    "재생하지 못했습니다. 다시 시도하세요.",
  ],
  playLine: ["このセリフを再生", "Play this line", "播放這句台詞", "播放这句台词", "이 대사 재생"],
  replay: ["もう一度再生", "Replay", "重新播放", "重新播放", "다시 재생"],
  partner: ["相手", "Partner", "互動角色", "互动角色", "상대"],
  unlockRank: [
    "キャラクターランク {0} で解放",
    "Unlocks at character rank {0}",
    "角色等級 {0} 解鎖",
    "角色等级 {0} 解锁",
    "캐릭터 랭크 {0}에 해금",
  ],
  unlockBond: [
    "キズナランク {0} で解放",
    "Unlocks at bond rank {0}",
    "羈絆等級 {0} 解鎖",
    "羁绊等级 {0} 解锁",
    "인연 랭크 {0}에 해금",
  ],
  normal: ["日常会話", "Daily dialogue", "日常對話", "日常对话", "일상 대화"],
  seasonal: ["季節のセリフ", "Seasonal dialogue", "季節台詞", "季节台词", "계절 대사"],
  birthday: ["誕生日", "Birthday", "生日", "生日", "생일"],
  levelUp: ["レベルアップ", "Level up", "等級提升", "等级提升", "레벨 업"],
  awaken: ["覚醒", "Awakening", "覺醒", "觉醒", "각성"],
  skillUp: ["スキルレベルアップ", "Skill level up", "技能升級", "技能升级", "스킬 레벨 업"],
  rankUp: ["ランクアップ", "Rank up", "Rank 提升", "Rank 提升", "랭크 업"],
  clear: ["ライブクリア", "Live clear", "演出完成", "演出完成", "라이브 클리어"],
  fullCombo: ["フルコンボ", "Full combo", "全連擊", "全连击", "풀 콤보"],
  allPerfect: ["オールパーフェクト", "All perfect", "全 Perfect", "全 Perfect", "올 퍼펙트"],
  result: ["ライブ結果", "Live results", "演出結果", "演出结果", "라이브 결과"],
  battleFirst: ["対バン・1位", "Battle · first place", "對戰・第一名", "对战・第一名", "대결 · 1위"],
  battleHigh: ["対バン・上位", "Battle · high rank", "對戰・高排名", "对战・高排名", "대결 · 상위"],
  battleLow: ["対バン・下位", "Battle · low rank", "對戰・低排名", "对战・低排名", "대결 · 하위"],
  start: ["ライブ開始", "Live opening", "演出開場", "演出开场", "라이브 시작"],
  skill: ["ライブスキル", "Live skill", "演出技能", "演出技能", "라이브 스킬"],
  combo: ["コンボ", "Combo", "連擊", "连击", "콤보"],
  call: ["呼びかけ", "Call", "呼喚", "呼唤", "호출"],
  response: ["応答", "Response", "回應", "回应", "응답"],
  gekisouCombo: ["激奏・コンボ", "Gekisou · combo", "激奏・連擊", "激奏・连击", "격주 · 콤보"],
  gekisouJust: ["激奏・JUST", "Gekisou · JUST", "激奏・JUST", "激奏・JUST", "격주 · JUST"],
  gekisouLuck: ["激奏・LUCK", "Gekisou · LUCK", "激奏・LUCK", "激奏・LUCK", "격주 · LUCK"],
  gekisouTop: ["激奏・最高ランク", "Gekisou · top rank", "激奏・最高排名", "激奏・最高排名", "격주 · 최고 랭크"],
  count: ["{0} 件", "{0} entries", "{0} 條", "{0} 条", "{0}개"],
  clip: ["セリフ {0} / {1}", "Line {0} of {1}", "第 {0} / {1} 句", "第 {0} / {1} 句", "{1}개 중 {0}번째 대사"],
};
export function voiceText(locale: string, key: string, ...values: Array<string | number>) {
  const index = Math.max(0, UI_LOCALES.indexOf(locale as (typeof UI_LOCALES)[number]));
  return (COPY[key]?.[index] || COPY[key]?.[1] || key).replace(/\{(\d+)\}/gu, (_, n: string) =>
    String(values[Number(n)] ?? ""),
  );
}
export const VOICE_GROUPS = ["daily", "growth", "gacha", "live", "interaction", "other"] as const;
export type VoiceGroup = (typeof VOICE_GROUPS)[number];
export function voiceGroup(entry: JsonRecord): VoiceGroup {
  switch (Number(entry.masterType)) {
    case 0:
      return "daily";
    case 1:
      return Number(entry.characterVoiceType) < 4 ? "growth" : "live";
    case 2:
      return "gacha";
    case 3:
    case 4:
    case 7:
      return "live";
    case 5:
    case 6:
      return "interaction";
    default:
      return "other";
  }
}
export function voiceTitleKey(entry: JsonRecord): string {
  switch (Number(entry.masterType)) {
    case 0:
      return Number(entry.birthdayCharacterId) > 0
        ? "birthday"
        : entry.seasonStartAt || entry.seasonEndAt
          ? "seasonal"
          : "normal";
    case 1:
      return (
        [
          "levelUp",
          "awaken",
          "skillUp",
          "rankUp",
          "clear",
          "fullCombo",
          "allPerfect",
          "result",
          "battleFirst",
          "battleHigh",
          "battleLow",
        ][Number(entry.characterVoiceType)] || "live"
      );
    case 2:
      return "gacha";
    case 3:
      return "skill";
    case 4:
      return ["gekisouCombo", "gekisouJust", "gekisouLuck", "gekisouTop"][Number(entry.gekisouVoiceType)] || "live";
    case 5:
    case 6:
      return Number(entry.dialogueType) === 2 ? "skill" : "combo";
    case 7:
      return "start";
    default:
      return "other";
  }
}
export interface VoiceLine {
  characterId: number;
  text: unknown;
  url: string;
  duration: number;
}
export function voiceLines(entry: JsonRecord): VoiceLine[] {
  const rows = Array.isArray(entry.lines) ? (entry.lines as JsonRecord[]) : [entry];
  return rows.map((line) => {
    const sound = line.sound && typeof line.sound === "object" ? (line.sound as JsonRecord) : {};
    return {
      characterId: Number(line.characterId || (entry.characterIds as unknown[] | undefined)?.[0] || 0),
      text: line.text,
      url: String(sound.playableUrl || line.playableUrl || ""),
      duration: Math.max(0, Number(sound.durationMs || 0) / 1000),
    };
  });
}
export function voiceKey(entry: JsonRecord): string {
  return String(entry.voiceKey || `${entry.masterType}:${entry.masterId}`);
}
export function compareVoices(a: JsonRecord, b: JsonRecord) {
  return (
    VOICE_GROUPS.indexOf(voiceGroup(a)) - VOICE_GROUPS.indexOf(voiceGroup(b)) ||
    Number(a.masterType) - Number(b.masterType) ||
    Number(a.masterId) - Number(b.masterId) ||
    voiceKey(a).localeCompare(voiceKey(b), "en", { numeric: true })
  );
}
