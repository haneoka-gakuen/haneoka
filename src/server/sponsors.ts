// L3 — GEB
// Input: AFDIAN_USER_ID／AFDIAN_TOKEN、PATREON_CREATOR_TOKEN（可选 PATREON_CAMPAIGN_ID）。
// Output: 按档位排序的现任赞助者与曾经的赞助者。
// Pos: [Map](L2-2.md)；构建期赞助者名单读取器。
// Effects/Dependencies: 构建输入捕获与两个平台的创作者 API；凭据缺失的平台不读取，已配置的平台读取失败则构建失败。
import { createHash } from "node:crypto";
import { sponsorTier, type SponsorPlatform, type SponsorTierId } from "../config/sponsor";
import { staticBuildJson } from "./static-input-store";

export interface Sponsor {
  name: string;
  avatar: string | null;
  platform: SponsorPlatform;
}
export interface ActiveSponsor extends Sponsor {
  tier: SponsorTierId;
}
export interface SponsorList {
  updatedAt: string;
  active: ActiveSponsor[];
  past: Sponsor[];
}

interface Row extends Sponsor {
  active: boolean;
  amount: number;
  currency: "CNY" | "USD";
  /** Lifetime support in CNY, only for ordering across platforms. */
  total: number;
  since: number;
}

const USD_TO_CNY = 7;
const MONTH = 32 * 24 * 3600;
const AVATAR_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(afdiancdn\.com|patreonusercontent\.com|patreon\.com)\//u;
const avatar = (url: unknown) =>
  typeof url === "string" && AVATAR_HOSTS.test(url) && !url.includes("/default/") ? url : null;
const name = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 40) : "");

async function retry<T>(load: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await load();
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
}

async function afdian(userId: string, token: string): Promise<Row[]> {
  const rows: Row[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (let page = 1, pages = 1; page <= pages; page++) {
    const params = JSON.stringify({ page, per_page: 100 });
    const ts = Math.floor(Date.now() / 1000);
    const sign = createHash("md5").update(`${token}params${params}ts${ts}user_id${userId}`).digest("hex");
    const body = await retry(async () => {
      const response = await fetch("https://afdian.com/api/open/query-sponsor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, params, ts, sign }),
        signal: AbortSignal.timeout(15000),
      });
      const json = (await response.json()) as {
        ec: number;
        em: string;
        data?: { total_page: number; list: unknown[] };
      };
      if (!response.ok || json.ec !== 200 || !json.data) throw new Error(`Afdian sponsors: ${json.ec} ${json.em}`);
      return json.data;
    });
    pages = body.total_page;
    for (const item of body.list as {
      current_plan?: { price?: string };
      all_sum_amount?: string;
      first_pay_time?: number;
      last_pay_time?: number;
      user?: { name?: string; avatar?: string };
    }[]) {
      const total = Number(item.all_sum_amount) || 0;
      const plan = Number(item.current_plan?.price) || 0;
      rows.push({
        name: name(item.user?.name),
        avatar: avatar(item.user?.avatar),
        platform: "afdian",
        active: now - (item.last_pay_time ?? 0) <= MONTH,
        amount: plan || total,
        currency: "CNY",
        total,
        since: item.first_pay_time ?? now,
      });
    }
  }
  return rows;
}

async function patreon(token: string, campaign: string): Promise<Row[]> {
  const rows: Row[] = [];
  let url: string | undefined =
    `https://www.patreon.com/api/oauth2/v2/campaigns/${campaign}/members?include=user` +
    "&fields%5Bmember%5D=full_name,patron_status,currently_entitled_amount_cents,lifetime_support_cents,pledge_relationship_start" +
    "&fields%5Buser%5D=image_url&page%5Bcount%5D=500";
  while (url) {
    const page: {
      data: {
        attributes: {
          full_name?: string;
          patron_status?: string | null;
          currently_entitled_amount_cents?: number;
          lifetime_support_cents?: number;
          pledge_relationship_start?: string | null;
        };
        relationships?: { user?: { data?: { id: string } } };
      }[];
      included?: { id: string; type: string; attributes: { image_url?: string } }[];
      links?: { next?: string };
    } = await retry(async () => {
      const response = await fetch(url!, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Patreon members: ${response.status}`);
      return response.json();
    });
    const users = new Map(
      (page.included ?? []).filter((row) => row.type === "user").map((row) => [row.id, row.attributes]),
    );
    for (const member of page.data) {
      const a = member.attributes;
      const lifetime = (a.lifetime_support_cents ?? 0) / 100;
      if (a.patron_status !== "active_patron" && lifetime <= 0) continue;
      rows.push({
        name: name(a.full_name),
        avatar: avatar(users.get(member.relationships?.user?.data?.id ?? "")?.image_url),
        platform: "patreon",
        active: a.patron_status === "active_patron",
        amount: (a.currently_entitled_amount_cents ?? 0) / 100,
        currency: "USD",
        total: lifetime * USD_TO_CNY,
        since: a.pledge_relationship_start ? Date.parse(a.pledge_relationship_start) / 1000 : Date.now() / 1000,
      });
    }
    url = page.links?.next;
  }
  return rows;
}

async function load(): Promise<SponsorList> {
  const env = process.env;
  const rows = (
    await Promise.all([
      env.AFDIAN_USER_ID && env.AFDIAN_TOKEN ? afdian(env.AFDIAN_USER_ID, env.AFDIAN_TOKEN) : [],
      env.PATREON_CREATOR_TOKEN ? patreon(env.PATREON_CREATOR_TOKEN, env.PATREON_CAMPAIGN_ID || "16408311") : [],
    ])
  )
    .flat()
    .filter((row) => row.name);
  // Larger lifetime support first, then the longest-standing.
  const order = (a: Row, b: Row) => b.total - a.total || a.since - b.since;
  return {
    updatedAt: new Date().toISOString(),
    active: rows
      .filter((row) => row.active)
      .sort(order)
      .map((row) => ({
        name: row.name,
        avatar: row.avatar,
        platform: row.platform,
        tier: sponsorTier(row.amount, row.currency),
      })),
    past: rows
      .filter((row) => !row.active)
      .sort(order)
      .map((row) => ({ name: row.name, avatar: row.avatar, platform: row.platform })),
  };
}

let list: Promise<SponsorList> | undefined;
/** Resolve once per build; shards read the list captured during preparation. */
export function sponsorList(): Promise<SponsorList> {
  return (list ??= staticBuildJson("sponsors:v1", "public-data", load));
}
