// L3 — GEB
// Input: The public server's pinned story catalogues and complete official scripts.
// Output: Published dialogue, its authored language variants and original command coordinates.
// Pos: [Map](L2-2.md); single language-neutral static dialogue search index per game release server.
// Effects/Dependencies: Reads the same release-pinned catalogues as the story workspaces.
import { projectHaneokaTranscript } from "@haneoka/vega-plugin-haneoka/transcript";
import { parseAdvRichText, type AdvRichTextNode } from "@haneoka/vega-plugin-richtext";
import { contentPublished, eventStoryStarts, withEventStart } from "../lib/content-publication";
import { resolveLocalizedText, resolveRelationshipText, TEXT_LOCALES } from "../lib/localized-text";
import { storyModeOf } from "../lib/resource-route";
import { storySourceUrl } from "../lib/story-assets";
import type { ReleaseServer } from "../lib/release-server";
import type { DialogueIndex, DialogueLine, DialogueText } from "../lib/story-dialogue";
import { asRecord, fetchStaticCatalog, fetchStaticCatalogBatch, staticCatalogRelease } from "../lib/static-catalog-source";
import { staticBuildJson } from "./static-input-store";

function visibleText(nodes: readonly AdvRichTextNode[]): string {
  return nodes.map((node) => {
    if (node.type === "text") return node.value;
    if (node.type === "ruby") return node.base;
    if (node.type === "break" || node.type === "space") return " ";
    return visibleText(node.children);
  }).join("");
}

function authoredText(value: unknown): DialogueText {
  const texts: DialogueText = {};
  for (const locale of TEXT_LOCALES) {
    const resolved = resolveLocalizedText(value, locale);
    const text = visibleText(parseAdvRichText(resolved.text)).replace(/\s+/gu, " ").trim();
    if (text) texts[typeof value === "string" ? "und" : resolved.locale] = text;
  }
  return texts;
}

const indexes = new Map<ReleaseServer, Promise<DialogueIndex>>();

export async function storyDialogueIndex(server: ReleaseServer): Promise<DialogueIndex> {
  const previous = indexes.get(server);
  if (previous) return previous;
  const result = staticBuildJson(`story-dialogue-index:${server}`, "public-data", () => buildStoryDialogueIndex(server));
  indexes.set(server, result);
  try {
    return await result;
  } catch (error) {
    indexes.delete(server);
    throw error;
  }
}

async function buildStoryDialogueIndex(server: ReleaseServer): Promise<DialogueIndex> {
  const release = await staticCatalogRelease(server);
  const [stories, characters] = await Promise.all([
    fetchStaticCatalog("stories?projection=4", server, release), fetchStaticCatalog("characters", server, release),
  ]);
  const root = asRecord(stories);
  const episodes = asRecord(root?.episodes);
  if (!root || !episodes) throw new Error(`Missing story catalogue for ${server}`);
  const people = new Map(Object.values(asRecord(characters) ?? {}).flatMap((raw) => {
    const row = asRecord(raw);
    return row ? [[String(row.characterId), row] as const] : [];
  }));
  const starts = eventStoryStarts(root);
  const eventChapterIds = new Set((Array.isArray(root.storyEvents) ? root.storyEvents : []).flatMap((raw) => {
    const chapterId = asRecord(raw)?.chapterId;
    return chapterId ? [String(chapterId)] : [];
  }));
  const selected = Object.entries(episodes).flatMap(([key, raw]) => {
    const row = asRecord(raw);
    if (!row) return [];
    const mode = storyModeOf(row, eventChapterIds);
    return mode ? [{ key, mode, episode: withEventStart(row, starts) }] : [];
  });
  const details = await fetchStaticCatalogBatch("stories", selected.map(({ key }) => key), server, release);
  const now = Date.now();
  const index: DialogueIndex = [];
  for (const { key, mode, episode } of selected) {
    const detail = details.get(key);
    if (!detail || !contentPublished(withEventStart({ ...episode, ...detail }, starts), now)) continue;
    const lines: DialogueLine[] = [];
    for (const entry of projectHaneokaTranscript(detail)) {
      if (entry.kind !== "dialogue" && entry.kind !== "message" && entry.kind !== "subtitle") continue;
      const command = entry.command;
      const text = authoredText(command.text);
      if (!Object.keys(text).length) continue;
      const authored = Array.isArray(command.targetTextNames) ? command.targetTextNames.filter(Boolean) : [];
      const targets = (Array.isArray(command.targets) ? command.targets : []).flatMap((value) => {
        const target = asRecord(value);
        return target ? [target] : [];
      });
      const targetNames = targets.map((target) => target.name || people.get(String(target.characterId))?.characterName).filter(Boolean);
      const speakers = authored.length ? authored : targetNames.length ? targetNames : [command.targetName];
      const status = Number(command.targetStatus);
      const speaker: DialogueText = status === 1 ? { und: "???" } : {};
      if (status !== 1 && status !== 2 && speakers.some(Boolean)) {
        for (const locale of TEXT_LOCALES) {
          const resolved = resolveRelationshipText(speakers, locale);
          if (resolved.text) speaker[locale] = visibleText(parseAdvRichText(resolved.text));
        }
      }
      const chatIcon = typeof command.chatIconAssetName === "string" ? command.chatIconAssetName : "";
      const portraits = status > 0 ? [] : chatIcon && entry.kind === "message"
        ? [storySourceUrl(`Assets/AddressableResources/Adv/Chat/Icon/${chatIcon}.png`, server)]
        : targets.map((target) => String(target.faceImage || people.get(String(target.characterId))?.faceImage || "")).filter(Boolean);
      const voices = entry.voices.map((voice) => String(voice.playableUrl || voice.url || "")).filter(Boolean);
      lines.push([entry.commandIndex, speaker, text, entry.kind, [...new Set(voices)], [...new Set(portraits)]]);
    }
    if (lines.length) index.push([String(episode.storyId ?? key), mode, authoredText(episode.title), lines]);
  }
  return index;
}
