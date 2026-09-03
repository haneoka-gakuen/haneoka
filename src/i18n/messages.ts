import ja from "../../public/i18n/ja.json";
import en from "../../public/i18n/en.json";
import ko from "../../public/i18n/ko.json";
import zhCN from "../../public/i18n/zh-CN.json";
import zhTW from "../../public/i18n/zh-TW.json";
import { localeFallbacks, type Locale } from "./locales";

const catalogs: Record<Locale, unknown> = { ja, en, "zh-TW": zhTW, "zh-CN": zhCN, ko };
const supplemental: Record<string, readonly [string, string, string, string, string]> = {
  category: ["カテゴリ", "Category", "分類", "分类", "분류"],
  initial: ["初期", "Initial", "初始", "初始", "초기"],
  rankUpItem: ["ランクアップ素材", "Rank-up item", "升階素材", "升阶素材", "랭크업 재료"],
  notes: ["ノーツ", "Notes", "音符", "音符", "노트"],
  battle: ["バトル", "Battle", "對戰", "对战", "배틀"],
  model: ["モデル", "Model", "模型", "模型", "모델"],
  family: ["ファミリー", "Family", "系列", "系列", "계열"],
  version: ["バージョン", "Version", "版本", "版本", "버전"],
  animations: ["アニメーション", "Animations", "動畫", "动画", "애니메이션"],
  playAll: ["すべて再生", "Play all", "全部播放", "播放全部", "모두 재생"],
  previous: ["前へ", "Previous", "上一個", "上一个", "이전"],
  next: ["次へ", "Next", "下一個", "下一个", "다음"],
  friendship: ["キズナ", "Character Bonds", "羈絆", "羁绊", "인연"],
  effectsByLevel: ["レベル別効果", "Effects by level", "各等級效果", "各等级效果", "레벨별 효과"],
  profile: ["プロフィール", "Profile", "個人資料", "个人资料", "프로필"],
  cards: ["カード", "Cards", "卡片", "卡片", "카드"],
  stamps: ["スタンプ", "Stamps", "貼圖", "表情", "스탬프"],
  voices: ["ボイス", "Voices", "語音", "语音", "보이스"],
  story: ["ストーリー", "Story", "故事", "故事", "스토리"],
  characterBonds: ["キャラクターキズナ", "Character Bonds", "角色羈絆", "角色羁绊", "캐릭터 인연"],
  schoolClass: ["クラス", "School class", "班級", "班级", "학급"],
  constellation: ["星座", "Constellation", "星座", "星座", "별자리"],
  favoriteFood: ["好きな食べ物", "Favorite food", "喜歡的食物", "喜欢的食物", "좋아하는 음식"],
  hatedFood: ["苦手な食べ物", "Disliked food", "不喜歡的食物", "不喜欢的食物", "싫어하는 음식"],
  missions: ["キャラクターミッション", "Character missions", "角色任務", "角色任务", "캐릭터 미션"],
  visual: ["ビジュアル", "Visual", "視覺", "视觉", "비주얼"],
  simple: ["シンプル", "Simple", "簡約", "简约", "간단"],
  watch: ["観賞", "Watch", "觀看", "观看", "감상"],
  time: ["時間", "Time", "時間", "时间", "시간"],
  score: ["スコア", "Score", "分數", "分数", "점수"],
  eff: ["効率", "Efficiency", "效率", "效率", "효율"],
  bpm: ["BPM", "BPM", "BPM", "BPM", "BPM"],
  n: ["ノーツ数", "Notes", "音符數", "音符数", "노트 수"],
  nps: ["NPS", "NPS", "NPS", "NPS", "NPS"],
  sr: ["スキル比率", "Skill ratio", "技能比率", "技能比率", "스킬 비율"],
};
const localeIndex = (locale: Locale) => Math.max(0, ["ja", "en", "zh-TW", "zh-CN", "ko"].indexOf(locale));
const lookup = (locale: Locale, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
      catalogs[locale],
    );
export function t(locale: Locale, path: string, fallback = path): string {
  for (const target of localeFallbacks(locale)) {
    const value = lookup(target, path);
    if (typeof value === "string" && value.trim()) return value;
  }
  return supplemental[path]?.[localeIndex(locale)] || fallback;
}
export function group<T = Record<string, unknown>>(locale: Locale, path: string): T {
  for (const target of localeFallbacks(locale)) {
    const value = lookup(target, path);
    if (value && typeof value === "object") return value as T;
  }
  return {} as T;
}
