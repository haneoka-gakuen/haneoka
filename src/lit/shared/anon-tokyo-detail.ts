import { html, nothing, type TemplateResult } from "lit";
import { specList, type SpecRow } from "../ui/spec";
import { icon } from "../ui/icon";
import { resolveLocalizedText } from "../../lib/localized-text";
import { recordValues, readPath } from "./catalog";

type Value = Record<string, unknown>;
interface Context {
  item: Value;
  data: Value;
  locale: string;
  mode: string;
  label(key: string): string;
  text(value: unknown): string;
  media(value: Value): string;
  title(value: Value): string;
  taskTitle(value: Value): string;
}
const domains: Record<string, { path: string; route?: string; label: string }> = {
  currency: { path: "progression.currencies", label: "currencies" },
  goods: { path: "goods.items", route: "goods", label: "goods" },
  outfit: { path: "goods.reloading", route: "outfits", label: "outfits" },
  decoration: { path: "shop.decorations", route: "decorations", label: "decorations" },
  character: { path: "characters", route: "characters", label: "characters" },
  tag: { path: "goods.tags", label: "tags" },
  category: { path: "goods.categories", label: "category" },
  task: { path: "tasks.main", route: "tasks", label: "tasks" },
  attribute: { path: "progression.attributes", label: "attributes" },
};
const entries = (value: unknown): string[][] => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Value;
    if (Array.isArray(record.entries))
      return record.entries.map((entry) => (((entry as Value).values as unknown[]) || []).map(String));
    return entries(record.raw);
  }
  return String(value || "")
    .split(";")
    .filter(Boolean)
    .map((part) => part.split(","));
};

export function renderAnonTokyoDetails(c: Context): TemplateResult {
  const { item, label } = c;
  const source = (path: string) => recordValues(readPath(c.data, path));
  const lookup = (domain: string, id: unknown) =>
    source(domains[domain]?.path || "").find((entry) => Number(entry.rawId) === Number(id));
  const object = (domain: string, id: unknown, count?: unknown): TemplateResult => {
    const entry = lookup(domain, id);
    const title = entry
      ? domain === "task"
        ? c.taskTitle(entry)
        : c.text(entry.name || entry.title || entry.levelDescription) || label(domains[domain]?.label || "unavailable")
      : label("unavailableObject");
    const image = entry ? c.media(entry) : "";
    const route = domains[domain]?.route;
    const content = html`
      ${
        image
          ? html`
              <img src=${image} alt="" loading="lazy" />
            `
          : icon("inventory_2", 24)
      }
      <span>${title}</span>
      ${
        count != null
          ? html`
              <strong>×${Number(count).toLocaleString(c.locale)}</strong>
            `
          : nothing
      }
    `;
    return entry && route
      ? html`
          <a
            class="detail-object"
            href=${`/catalog/anon-tokyo/${route}/?item=${encodeURIComponent(String(entry.id))}${domain === "outfit" && ((Array.isArray(entry.characterIds) && entry.characterIds.length) || c.mode === "characters") ? `&character=at-character-${Number((entry.characterIds as unknown[] | undefined)?.[0] || item.rawId)}` : ""}`}
          >
            ${content}
          </a>
        `
      : html`
          <span class="detail-object">${content}</span>
        `;
  };
  const objects = (domain: string, ids: unknown) =>
    Array.isArray(ids) && ids.length
      ? html`
          <div class="detail-object-list">${ids.filter((id) => Number(id) > 0).map((id) => object(domain, id))}</div>
        `
      : nothing;
  const section = (title: string, body: unknown) => html`
    <section class="detail-section anon-detail-section">
      <h3 class="detail-section-title">${label(title)}</h3>
      ${body}
    </section>
  `;
  const facts: SpecRow[] = [];
  const add = (key: string, value: unknown, wide = false) => {
    if (value !== undefined && value !== null && value !== "") facts.push({ label: label(key), value, wide });
  };
  const amount = (value: unknown) => Number(value).toLocaleString(c.locale);
  const duration = (value: unknown) => `${amount(value)} ${label("seconds")}`;
  const level = (value: unknown) => (Number(value) > 0 ? `Lv.${value}` : label("noLevelRequirement"));
  const data = item.values && typeof item.values === "object" ? (item.values as Value) : item;
  if (item.levelLimit != null && c.mode !== "characters") add("unlockLevel", level(item.levelLimit));
  if (item.levelLimited != null) add("unlockLevel", level(item.levelLimited));
  if (item.level != null) add("level", `Lv.${item.level}`);
  if (item.customerCount != null) add("customerCapacity", amount(item.customerCount));
  if (Array.isArray(item.size)) add("roomSize", item.size.join(" × "));
  if (item.exp != null) add("experience", amount(item.exp));
  if (item.strengthLimit != null) add("strengthLimit", amount(item.strengthLimit));
  if (item.point != null) add("point", amount(item.point));
  if (item.durationSeconds != null) add("duration", duration(item.durationSeconds));
  if (data.customerLv != null) add("customerLevel", `Lv.${data.customerLv}`);
  if (data.basePurchaseCount != null) add("quantity", amount(data.basePurchaseCount));
  if (data.guidedShopping != null) add("guidedShopping", label(data.guidedShopping ? "yes" : "no"));
  if (data.minStayDuration != null && data.maxStayDuration != null)
    add("stayDuration", `${data.minStayDuration}–${data.maxStayDuration} ${label("seconds")}`);
  if (item.deliveryDuration != null) add("deliveryTime", duration(item.deliveryDuration));
  if (item.categoryId != null) add("category", object("category", item.categoryId));
  if (Array.isArray(item.tagIds) && item.tagIds.length) add("tags", objects("tag", item.tagIds), true);
  const popularity = item.popularity && typeof item.popularity === "object" ? (item.popularity as Value) : {};
  if (popularity.count != null) add("popularity", `+${amount(popularity.count)}`);
  if (popularity.shopRequirement != null) add("popularityRequired", amount(popularity.shopRequirement));
  if (Number(item.maxLimitCount) > 0) add("limit", amount(item.maxLimitCount));
  if (item.unlockShopLevel != null) add("unlockShopLevel", level(item.unlockShopLevel));
  if (item.guaranteed != null) add("guaranteed", label(item.guaranteed ? "yes" : "no"));
  if (item.weight != null) add("weight", amount(item.weight));
  const availability = item.availability && typeof item.availability === "object" ? (item.availability as Value) : {};
  const date = (value: unknown) => {
    const timestamp =
      typeof value === "number"
        ? value > 0
          ? value * (value < 1e12 ? 1000 : 1)
          : NaN
        : typeof value === "string" && value
          ? Date.parse(value)
          : NaN;
    return Number.isFinite(timestamp)
      ? new Intl.DateTimeFormat(c.locale, { dateStyle: "medium" }).format(timestamp)
      : "";
  };
  add("start", date(availability.start || item.startAt));
  add("end", date(availability.end || item.endAt));
  const description = c.text(item.description || item.hint || item.text);
  const unlock = item.unlock && typeof item.unlock === "object" ? (item.unlock as Value) : {};
  const purchase = item.purchase && typeof item.purchase === "object" ? (item.purchase as Value) : {};
  const sale = item.sale && typeof item.sale === "object" ? (item.sale as Value) : {};
  const conditions: unknown[] = [];
  if (Number(unlock.levelLimit) > 0)
    conditions.push(html`
      <p>${label("unlockLevel")} · Lv.${unlock.levelLimit}</p>
    `);
  if (Number(unlock.count) > 0 && unlock.itemId != null)
    conditions.push(object("currency", unlock.itemId, unlock.count));
  if (Number(unlock.costCount) > 0 && unlock.costType != null)
    conditions.push(object("currency", unlock.costType, unlock.costCount));
  if (Number(item.unlockCostCount) > 0) conditions.push(object("currency", item.unlockCostType, item.unlockCostCount));
  if (Array.isArray(unlock.clothIds) && unlock.clothIds.some(Number))
    conditions.push(objects("outfit", unlock.clothIds));
  if (purchase.itemId != null && Number(purchase.count) > 0)
    conditions.push(object("currency", purchase.itemId, purchase.count));
  const skills: unknown[] = [];
  for (const entry of Array.isArray(item.passiveAbilityEntries) ? (item.passiveAbilityEntries as Value[]) : []) {
    const params = Array.isArray(entry.values) ? entry.values : [];
    const ability = source("progression.passiveAbilities").find(
      (ability) => Number(ability.rawId) === Number(params[0]),
    );
    if (!ability) continue;
    const name = resolveLocalizedText(ability.name, c.locale);
    const effect = resolveLocalizedText(ability.value, c.locale);
    skills.push(html`
      <article class="detail-ability">
        ${
          c.media(ability)
            ? html`
                <img src=${c.media(ability)} alt="" loading="lazy" />
              `
            : icon("stars", 24)
        }
        <div>
          <strong lang=${name.locale}>${name.text}</strong>
          <p lang=${effect.locale}>${effect.text.replace(/\{0\}/gu, String(params[1] ?? ""))}</p>
        </div>
      </article>
    `);
  }
  for (const [field, path] of [
    ["helperSkillReward", "staffing.helperSkills"],
    ["deliverySkillReward", "staffing.deliverySkills"],
  ] as const) {
    for (const [id, value] of entries(item[field])) {
      const ability = source(path).find((entry) => Number(entry.rawId) === Number(id));
      if (!ability) continue;
      let text = c.text(ability.name);
      if (!text || /^(?:helper|delivery)-skill:\d+$/u.test(text))
        text = label(String(ability.nameKey || "").endsWith("delivery_time") ? "deliveryTime" : "orderCapacity");
      skills.push(html`
        <article class="detail-ability">
          ${icon("bolt", 24)}
          <div>
            <strong>${text.includes("{0}") ? text.replace(/\{0\}/gu, value || "") : text}</strong>
            ${
              !text.includes("{0}")
                ? html`
                    <p>${value}</p>
                  `
                : nothing
            }
          </div>
        </article>
      `);
    }
  }
  const rewards = entries(item.reward);
  const rewardDomains: Record<number, string> = {
    1: "currency",
    2: "decoration",
    3: "goods",
    4: "outfit",
    5: "attribute",
    6: "character",
    7: "goods",
  };
  const rewardObjects = rewards.map(([kind, id, count]) => {
    const domain = rewardDomains[Number(kind)];
    if (domain === "attribute") {
      const attribute = lookup(domain, id);
      const description = c.text(attribute?.description);
      if (description)
        return html`
          <span class="detail-object">
            ${
              attribute && c.media(attribute)
                ? html`
                    <img src=${c.media(attribute)} alt="" />
                  `
                : icon("trending_up", 24)
            }
            <span>${description.replace(/\{0\}/gu, String(count || ""))}</span>
          </span>
        `;
    }
    return object(domain || "goods", id, count);
  });
  const namedReward = item.reward && typeof item.reward === "object" ? (item.reward as Value) : {};
  if (!rewards.length && namedReward.type === "star" && namedReward.count != null)
    rewardObjects.push(html`
      <span class="detail-object">
        ${icon("star", 24)}
        <span>${label("stars")}</span>
        <strong>×${amount(namedReward.count)}</strong>
      </span>
    `);
  const economy: SpecRow[] = [];
  if (purchase.cost != null) economy.push({ label: label("unitCost"), value: object("currency", 1, purchase.cost) });
  if (purchase.cost != null && purchase.count != null)
    economy.push({ label: label("orderQuantity"), value: amount(purchase.count) });
  for (const [key, title] of [
    ["coinCounts", "sellPrice"],
    ["expCounts", "sellExp"],
    ["discardCoinCounts", "discardCoinCounts"],
  ]) {
    const rows = sale[key!] as unknown[] | undefined;
    if (Array.isArray(rows) && rows.length) economy.push({ label: label(title!), value: rows.map(amount).join(" / ") });
  }
  if (sale.itemId != null && Number(sale.count) > 0)
    economy.push({ label: label("sellPrice"), value: object("currency", sale.itemId, sale.count) });
  const taskReferences = objects("task", item.taskIds);
  const task = c.mode === "tasks" ? c.taskTitle(item) : "";
  const guideImages =
    c.mode === "guide"
      ? source("guides.imagePages")
          .filter((entry) => Number(entry.carouselId) === Number(item.carouselId))
          .map((entry) => ({
            id: String(entry.id),
            source: c.media(entry),
            label: `${label("page")} ${Number(entry.pageIndex || 0) + 1}`,
          }))
          .filter((entry) => entry.source)
      : [];
  return html`
    <div class="anon-detail-sections">
      ${
        task
          ? section(
              "tasks",
              html`
                <p class="detail-primary-copy">${task}</p>
              `,
            )
          : description && description !== c.title(item)
            ? section(
                "details",
                html`
                  <p class="detail-primary-copy">${description}</p>
                `,
              )
            : nothing
      }
      ${facts.length ? section("details", specList(facts, { split: true })) : nothing}
      ${
        skills.length
          ? section(
              "skill",
              html`
                <div class="detail-ability-list">${skills}</div>
              `,
            )
          : nothing
      }
      ${
        conditions.length
          ? section(
              "condition",
              html`
                <div class="detail-object-list">${conditions}</div>
              `,
            )
          : nothing
      }
      ${economy.length ? section("goodsEconomy", specList(economy, { split: true })) : nothing}
      ${
        rewardObjects.length
          ? section(
              "reward",
              html`
                <div class="detail-object-list">${rewardObjects}</div>
              `,
            )
          : nothing
      }
      ${Array.isArray(item.defaultAvatarIds) && c.mode === "characters" ? section("defaultOutfit", objects("outfit", item.defaultAvatarIds)) : nothing}
      ${Array.isArray(item.feverAvatarIds) && c.mode === "characters" ? section("fever", objects("outfit", item.feverAvatarIds)) : nothing}
      ${Array.isArray(item.feverCharacterIds) ? section("characters", objects("character", item.feverCharacterIds)) : nothing}
      ${Array.isArray(item.taskIds) && item.taskIds.length ? section("tasks", taskReferences) : nothing}
      ${
        c.mode === "fever" && (item.cueName || item.pathName) && !item.playableUrl
          ? html`
              <p class="state__body">${label("audioUnavailable")}</p>
            `
          : nothing
      }
      ${
        guideImages.length
          ? section(
              "guide",
              html`
                <image-gallery .images=${guideImages} locale=${c.locale}></image-gallery>
              `,
            )
          : nothing
      }
    </div>
  `;
}
