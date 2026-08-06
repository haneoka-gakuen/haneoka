import { flagIconUrls } from "~/utils/flagIcons";
import { publisherIconUrls } from "~/utils/publisherIcons";

const normalizedServer = (server: unknown): string => String(server || "").toLocaleLowerCase();

/** Presentation metadata for the historical Japan CBT release, not source routing. */
const JAPAN_CBT_RELEASE_ID = "jp-cbt";
/** Presentation metadata for the bilibili Global CBT release. */
const GLOBAL_CBT_RELEASE_ID = "gl-cbt";
const BETA_BADGE_RELEASE_IDS = new Set([JAPAN_CBT_RELEASE_ID, GLOBAL_CBT_RELEASE_ID]);

export const serverUsesBetaBadge = (server: unknown): boolean =>
  BETA_BADGE_RELEASE_IDS.has(normalizedServer(server));

export const serverIconUrl = (server: unknown): string => {
  const value = normalizedServer(server);
  if (value === JAPAN_CBT_RELEASE_ID) return publisherIconUrls.bushimo;
  if (value === GLOBAL_CBT_RELEASE_ID) return publisherIconUrls.bilibili;
  if (value.includes("bilibili") || value.includes("bili")) return publisherIconUrls.bilibili;
  if (value.startsWith("jp") || value.includes("japan")) return flagIconUrls.jp;
  if (value.startsWith("kr") || value.startsWith("ko") || value.includes("korea")) return flagIconUrls.kr;
  if (value.startsWith("hk") || value.includes("tw")) return flagIconUrls.hk;
  if (value.startsWith("cn") || value.includes("china")) return flagIconUrls.cn;
  return flagIconUrls.gb;
};
