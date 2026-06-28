import { flagIconUrls } from "~/utils/flagIcons";
import { publisherIconUrls } from "~/utils/publisherIcons";

const normalizedServer = (server: unknown): string => String(server || "").toLocaleLowerCase();

export const serverUsesBetaBadge = (server: unknown): boolean => normalizedServer(server).includes("jp-cbt");

export const serverIconUrl = (server: unknown): string => {
  const value = normalizedServer(server);
  if (value.includes("jp-cbt")) return publisherIconUrls.bushimo;
  if (value.includes("bilibili") || value.includes("bili")) return publisherIconUrls.bilibili;
  if (value.startsWith("jp") || value.includes("japan")) return flagIconUrls.jp;
  if (value.startsWith("kr") || value.startsWith("ko") || value.includes("korea")) return flagIconUrls.kr;
  if (value.startsWith("hk") || value.includes("tw")) return flagIconUrls.hk;
  if (value.startsWith("cn") || value.includes("china")) return flagIconUrls.cn;
  return flagIconUrls.gb;
};
