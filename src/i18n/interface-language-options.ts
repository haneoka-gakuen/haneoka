export const interfaceLanguages = [
  { value: "de", label: "Deutsch", tag: "de-DE" },
  { value: "es", label: "Español", tag: "es-ES" },
  { value: "fr", label: "Français", tag: "fr-FR" },
  { value: "id", label: "Bahasa Indonesia", tag: "id-ID" },
  { value: "it", label: "Italiano", tag: "it-IT" },
  { value: "pl", label: "Polski", tag: "pl-PL" },
  { value: "pt", label: "Português (Brasil)", tag: "pt-BR" },
  { value: "ru", label: "Русский", tag: "ru-RU" },
  { value: "th", label: "ไทย", tag: "th-TH" },
  { value: "vi", label: "Tiếng Việt", tag: "vi-VN" },
] as const;

export type InterfaceLanguage = (typeof interfaceLanguages)[number];
export type InterfaceLanguageId = InterfaceLanguage["value"];
export const SHARE_LANGUAGE_STORAGE_KEY = "haneoka.share-interface-language";
