# L3 — GEB
# Input: Same-server card catalogues, Master pools and projected rewards.
# Output: Acquisition type and cited acquisition sources of each member card or snapshot.
# Pos: [Build map](L2-2.md); called by the canonical API compiler.
# Effects/Dependencies: Enriches supplied card records with acquisition fields.
from __future__ import annotations

from typing import Any, Literal


# dreamfes and campaign are reserved until Master provides evidence for those releases.
CardAcquisitionType = Literal[
    "permanent", "limited", "birthday", "event", "pass", "gift", "unknown", "dreamfes", "campaign",
]


ANNOUNCED_SNAPSHOT_GIFTS = (
    # Global 800,000 preregistrations: https://www.fromtyo.jp/news/20260721
    (("jp", "intl"), "61", "https://www.fromtyo.jp/news/20260721"),
    # prima aurora ticket-holder bonus: https://haneoka.org/jp/ja/announcements/53/
    (("jp",), "69", "https://haneoka.org/jp/ja/announcements/53/"),
)


def set_card_types(
    data: Any, cards: dict[str, Any], systems: dict[str, Any], *, resource_type: int,
) -> None:
    """Classify acquisition from same-server draw pools, rewards and documented gifts."""
    debut: dict[str, dict[CardAcquisitionType, set[tuple[str, str]]]] = {}
    regular_pool: dict[str, str] = {}

    def record(key: str, kind: CardAcquisitionType, resource: str, source: str) -> None:
        debut.setdefault(key, {}).setdefault(kind, set()).add((resource, str(source)))
    pools = systems.get("gacha", {}).get("entries", {})
    for row in data.rows("MasterGacha"):
        pool = pools.get(str(row.get("_id")))
        limited = row.get("_isLimited")
        if not pool or pool["category"] != "stars" or not isinstance(limited, bool):
            continue
        # An open, unrestricted star pool provides permanent availability even for
        # launch cards whose master release predates the first pickup banners.
        regular = (
            not limited
            and "_endAt" in row and row["_endAt"] in ("", None, "null")
            and pool["displayCondition"] == 1
            and not pool["beginnerHours"] and not pool["comebackHours"]
        )
        start = pool["startAt"][0]
        for prize in pool["rewards"]:
            key = str(prize["resourceId"])
            if prize["resourceType"] != resource_type or key not in cards or prize["rate"] <= 0:
                continue
            if regular:
                regular_pool.setdefault(key, str(row["_id"]))
            if start and prize["pickup"] and start == cards[key]["releasedAt"][0]:
                kind: CardAcquisitionType = "permanent"
                if limited:
                    kind = "birthday" if cards[key]["rarity"] == 20 else "limited"
                record(key, kind, "gacha", str(row["_id"]))

    def record_reward(
        reward: dict[str, Any], start: int, kind: CardAcquisitionType, resource: str, source: str,
    ) -> None:
        key = str(reward["resourceId"])
        if (
            reward["resourceType"] == resource_type and reward["count"] > 0 and start
            and key in cards and cards[key]["releasedAt"][0] == start
        ):
            record(key, kind, resource, source)

    events = systems.get("events", {}).get("entries", {})
    for event in events.values():
        start = event["startAt"][0]
        for reward in event["rewards"]:
            if reward["resourceType"] == resource_type:
                record_reward(reward["reward"], start, "event", "events", event["id"])

    exchanges = systems.get("exchange", {}).get("entries", {})
    for row in data.rows("MasterExchange"):
        if row.get("_targetDisplay") != 1:
            continue
        event = events.get(str(row.get("_targetDisplayId")))
        exchange = exchanges.get(str(row.get("_id")))
        if not event or not exchange:
            continue
        featured = {item["resourceId"] for item in event["pickupCards"] if item["resourceType"] == resource_type}
        start = event["startAt"][0]
        for product in exchange["products"]:
            reward = product["reward"]
            if reward["resourceId"] in featured:
                record_reward(reward, start, "event", "exchange", exchange["id"])

    for entry in systems.get("passes", {}).get("entries", {}).values():
        if entry["kind"] == "season-pass":
            for level in entry["levels"]:
                for reward in level["rewards"]:
                    record_reward(reward, entry["startAt"][0], "pass", "passes", entry["id"])

    for entry in systems.get("login-campaigns", {}).get("entries", {}).values():
        if not entry["premium"]:
            for slot in entry["rewards"]:
                record_reward(slot["reward"], entry["startAt"][0], "gift", "login-campaigns", entry["id"])

    # The global preregistration gift and the JP cinema voucher were announced
    # outside the Master reward tables. Key these exceptions to their catalog.
    if resource_type == 3:
        for servers, card_id, href in ANNOUNCED_SNAPSHOT_GIFTS:
            if data.server in servers and card_id in cards:
                record(card_id, "gift", "announcement", href)

    for key, card in cards.items():
        kinds = debut.get(key, {})
        sources: set[tuple[str, str]] = set()
        if len(kinds) == 1:
            card["type"], sources = next(iter(kinds.items()))
        elif not kinds and key in regular_pool:
            card["type"] = "permanent"
            sources.add(("gacha", regular_pool[key]))
        else:
            card["type"] = "unknown"
        card["acquisitionSources"] = [
            {"resource": resource, "id": source} for resource, source in sorted(sources)
        ]
