"""Studio practice levels, drop pools and band-rank EXP factors."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from build.game_systems import _number, _resource


def build_studio(data: Any, documents: dict[str, Any], resource_types: dict[int, str]) -> dict[str, Any]:
    drops: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in sorted(data.rows("MasterOfflineBonusItemLot"), key=lambda row: _number(row, "_id")):
        drops[_number(row, "_groupId")].append({
            "weight": _number(row, "_weight"),
            "reward": _resource(
                data, documents, resource_types,
                _number(row, "_resourceType"),
                _number(row, "_resourceId"),
                _number(row, "_resourceCount"),
            ),
        })
    levels: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in sorted(
        data.rows("MasterOfflineBonusUnitLevel"),
        key=lambda row: (_number(row, "_offlineBonusUnitId"), _number(row, "_offlineBonusLevel")),
    ):
        levels[_number(row, "_offlineBonusUnitId")].append({
            "level": _number(row, "_offlineBonusLevel"),
            "exp": _number(row, "_offlineBonusExp"),
            "bandRank": _number(row, "_unlockBandRank"),
            "efficiencyTime": _number(row, "_offlineEfficiencyTime"),
            "limitTime": _number(row, "_offlineLimitTime"),
            "coin": _number(row, "_earnCoin"),
            "memberExp": _number(row, "_earnMemberExp"),
            "supportExp": _number(row, "_earnSupportExp"),
            "studioExp": _number(row, "_earnOfflineBonusExp"),
            "draws": _number(row, "_earnItemLot"),
            "dropGroup": _number(row, "_itemLotGroupId"),
        })
    bands = documents.get("bands", {})
    units = []
    for row in sorted(data.rows("MasterOfflineBonusUnit"), key=lambda row: _number(row, "_id")):
        unit = _number(row, "_id")
        band = bands.get(str(_number(row, "_bandId"))) or {}
        unit_levels = levels.get(unit, [])
        groups = sorted({level["dropGroup"] for level in unit_levels})
        units.append({
            "id": unit,
            "bandId": _number(row, "_bandId"),
            "name": band.get("bandName") or [str(row.get("_name") or "")],
            "icon": band.get("icon") or "",
            "logo": band.get("logo") or "",
            "bgmSoundId": _number(row, "_bgmSoundId"),
            "startAt": str(row.get("_startAt") or ""),
            "levels": unit_levels,
            "drops": {str(group): drops.get(group, []) for group in groups},
        })
    def item(identity: int) -> dict[str, Any]:
        return _resource(data, documents, resource_types, 1, identity)

    return {
        "units": units,
        "rewards": {"coin": item(3), "memberExp": item(5), "supportExp": item(6)},
        "skipItems": [
            item(int(record["itemId"]))
            for record in documents["items"]["items"].values()
            if record.get("itemTypeName") == "OfflineBonusSkip"
        ],
        "expFactors": [
            {"bandRank": _number(row, "_bandRank"), "factor": _number(row, "_expFactor")}
            for row in sorted(data.rows("MasterOfflineBonusExpFactor"), key=lambda row: _number(row, "_bandRank"))
        ],
    }
