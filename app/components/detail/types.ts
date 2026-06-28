import type { DisplayText } from "~/types/displayText";

export type DetailMediaRatio = "square" | "member" | "support" | "portrait" | "comic" | "stamp";

export interface DetailMediaItem {
  id: string;
  label: DisplayText;
  src: string;
  thumbnail?: string;
  ratio?: DetailMediaRatio;
  fit?: "cover" | "contain";
}

export interface DetailPeerItem {
  id: string;
  label: string;
  icon?: string;
  count?: number;
}

/** Visual-only identity metadata placed before a detail title. */
export interface DetailHeaderIconItem {
  id: string | number;
  label: DisplayText;
  color?: string;
  icon?: string;
  image?: string;
  imageCandidates?: string[];
  text?: string;
  lang?: string;
  shape?: "avatar" | "logo" | "icon";
}
