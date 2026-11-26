import type { StoryMode } from "./resource-route";
import type { Locale } from "../i18n/locales";

export type DialogueText = Record<string, string>;
export type DialogueKind = "dialogue" | "message" | "subtitle";
export type DialogueLine = [command: number, speaker: DialogueText, text: DialogueText, kind: DialogueKind, voices: string[], portraits: string[]];
export type DialogueEpisode = [id: string, mode: StoryMode, title: DialogueText, lines: DialogueLine[]];
export type DialogueIndex = DialogueEpisode[];
export type DialogueQuery = {
  locale: Locale;
  query: string;
  mode: "text" | "regex" | "semantic";
  terms?: string[];
  category: string;
  speaker: string;
};
export interface DialogueHit {
  id: string;
  index: number;
  command: number;
  title: string;
  speaker: string;
  text: string;
  textLanguage: string;
  kind: DialogueKind;
  voices: string[];
  avatars: { src: string; name: string }[];
  contextBefore: string;
  contextAfter: string;
  matchedText?: string;
  matchedLocale?: string;
}
export type DialogueReply = {
  phase: "ready" | "error" | "invalid";
  results?: DialogueHit[];
  speakers?: string[];
  terms?: string[];
};
