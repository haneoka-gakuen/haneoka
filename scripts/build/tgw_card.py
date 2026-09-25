"""T.G.W CARD ranks, benefits and rewards from the game's Master tables."""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

from build.game_systems import _resource


RANK_IMAGE = re.compile(
    r"^Assets/AddressableResources/Image/Tgw/tgwcard_[^/]+_(\d+)\.png$"
)


def build_tgw_card(data: Any, documents: dict[str, Any], resource_types: dict[int, str]) -> dict[str, Any]:
    images = {}
    for path in data.source_paths:
        match = RANK_IMAGE.fullmatch(path)
        if match:
            images[int(match[1])] = data.asset(path)
    daily_rewards: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterVipDailyReward"):
        rank = int(row.get("_vipRank") or 0)
        daily_rewards[rank].append({
            "day": int(row.get("_day") or 0),
            "reward": _resource(
                data, documents, resource_types,
                int(row.get("_resourceType") or 0),
                int(row.get("_resourceId") or 0),
                int(row.get("_resourceCount") or 0),
            ),
        })
    rank_rewards: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterVipRankUpReward"):
        rank = int(row.get("_vipRank") or 0)
        rank_rewards[rank].append(_resource(
            data, documents, resource_types,
            int(row.get("_resourceType") or 0),
            int(row.get("_resourceId") or 0),
            int(row.get("_resourceCount") or 0),
        ))
    benefits: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterVipRankBonus"):
        rank = int(row.get("_vipRank") or 0)
        kind = int(row.get("_vipBonusType") or 0)
        benefits[rank].append({
            "name": data.text(f"ui_vip_bonus_type_{kind}"),
            "value": int(row.get("_value") or 0),
        })
    base_name = data.text("ui_title_vip_top")
    rank_name = data.text("ui_vip_rank")
    entries = {}
    for row in data.rows("MasterVip"):
        rank = int(row.get("_vipRank") or 0)
        if not rank:
            continue
        title = [
            " ".join(part for part in (base_name[index], rank_name[index], str(rank)) if part)
            for index in range(5)
        ]
        entries[str(rank)] = {
            "id": str(rank),
            "title": title,
            "rank": rank,
            "pointsRequired": int(row.get("_point") or 0),
            "image": images.get(rank) or "",
            "dailyRewards": sorted(daily_rewards[rank], key=lambda reward: reward["day"]),
            "rankRewards": rank_rewards[rank],
            "benefits": benefits[rank],
            "sourceTable": "MasterVip",
        }
    return {
        "entries": entries,
        "title": base_name,
        "intro": data.text("Faq_Detail_29"),
        "pointName": data.text("ui_vip_point"),
        "dailyPoints": [
            {
                "consecutiveDays": int(row.get("_consecutiveCount") or 0),
                "points": int(row.get("_point") or 0),
            }
            for row in sorted(data.rows("MasterVipDailyPoint"), key=lambda row: int(row.get("_consecutiveCount") or 0))
        ],
    }
