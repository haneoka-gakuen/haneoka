// L3 — GEB
// Input: Interface language options and bundled Circle Flags icons.
// Output: Ordered language labels and matching icons for the settings and friend links pages.
// Pos: [Map](L2-2.md); shared interface language display.
// Effects/Dependencies: Uses local Circle Flags assets in the frontend bundle.
import cnFlag from "circle-flags/flags/cn.svg?url";
import enUsFlag from "circle-flags/flags/language/en-us.svg?url";
import hkFlag from "circle-flags/flags/hk.svg?url";
import jpFlag from "circle-flags/flags/jp.svg?url";
import krFlag from "circle-flags/flags/kr.svg?url";
import deFlag from "circle-flags/flags/de.svg?url";
import esFlag from "circle-flags/flags/es.svg?url";
import frFlag from "circle-flags/flags/fr.svg?url";
import idFlag from "circle-flags/flags/id.svg?url";
import itFlag from "circle-flags/flags/it.svg?url";
import plFlag from "circle-flags/flags/pl.svg?url";
import ptFlag from "circle-flags/flags/br.svg?url";
import ruFlag from "circle-flags/flags/ru.svg?url";
import thFlag from "circle-flags/flags/th.svg?url";
import viFlag from "circle-flags/flags/vn.svg?url";
import { interfaceLanguages, type InterfaceLanguageId } from "./interface-language-options";

const interfaceFlags = {
  de: deFlag,
  es: esFlag,
  fr: frFlag,
  id: idFlag,
  it: itFlag,
  pl: plFlag,
  pt: ptFlag,
  ru: ruFlag,
  th: thFlag,
  vi: viFlag,
} satisfies Record<InterfaceLanguageId, string>;

export const languageFlags = [
  { value: "ja", image: jpFlag, label: "日本語" },
  { value: "en", image: enUsFlag, label: "English" },
  { value: "zh-TW", image: hkFlag, label: "繁體中文" },
  { value: "zh-CN", image: cnFlag, label: "简体中文" },
  { value: "ko", image: krFlag, label: "한국어" },
  ...interfaceLanguages.map((language) => ({ ...language, image: interfaceFlags[language.value] })),
] as const;
