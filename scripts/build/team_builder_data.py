"""Selected, source-pinned Master inputs for inventory and team calculation."""
from __future__ import annotations
from typing import Any

TABLES = {
    "playerRanks": "MasterPlayerRank", "characterRanks": "MasterCharacterRank",
    "characterTotalRanks": "MasterCharacterTotalRank",
    "bandRanks": "MasterBandRank", "bandTypeRanks": "MasterBandTypeRank",
    "memberCardLevels": "MasterMemberCardLevel", "supportCardLevels": "MasterSupportCardLevel",
    "memberCardRanks": "MasterMemberCardRank", "supportCardRanks": "MasterSupportCardRank",
    "memberCardAwake": "MasterMemberCardAwake", "memberCardLevelLimits": "MasterMemberCardLevelLimit",
    "memberCardAwakeResources": "MasterMemberCardAwakeResource", "skillLevelResources": "MasterSkillLevelResource",
}
RUNTIME_TABLES = {
    "parameters": "MasterParameter",
    "vipRanks": "MasterVip", "vipRankBonuses": "MasterVipRankBonus",
    "memoryMemberLevels": "MasterMemoryMemberLevel", "memorySupportLevels": "MasterMemorySupportLevel",
    "memoryMusic": "MasterMemoryMusic", "memoryMusicBonuses": "MasterMemoryMusicBonus", "memoryMusicGroups": "MasterMemoryMusicGroup",
}


def build_team_builder_data(data: Any, source_id: str) -> dict[str, Any]:
    def exact(table: str) -> list[dict[str, Any]]:
        return [{"sourceTable": table, **{key.removeprefix("_"): value for key, value in row.items()}}
                for row in data.rows(table)]

    members = {}
    for row in data.rows("MasterMemberCard"):
        identity = int(row["_id"])
        members[str(identity)] = {
            "cardId": identity, "prefix": data.text(row.get("_subtitleTextID")),
            "images": {"thumbnail": data.asset(f"Assets/AddressableResources/MemberCard/{identity}/member_thumbnail.png")},
            **{key.removeprefix("_"): value for key, value in row.items()},
        }
    snapshots = {}
    for row in data.rows("MasterSupportCard"):
        identity = int(row["_id"])
        snapshots[str(identity)] = {
            "supportCardId": identity, "prefix": data.text(row.get("_descriptionTextID")),
            "cardName": data.text(row.get("_nameTextID")),
            "images": {"thumbnail": data.asset(f"Assets/AddressableResources/SupportCard/{identity}/snap_thumbnail.png")},
            **{key.removeprefix("_"): value for key, value in row.items()},
        }
    skills = {}
    for resource, table, effects, foreign in [
        ("leader-skills", "MasterLeaderSkill", "MasterLeaderSkillEffect", "leaderSkillID"),
        ("skills", "MasterLiveSkill", "MasterLiveSkillEffect", "liveSkillID"),
        ("gekisou-skills", "MasterGekisouSkill", "MasterGekisouSkillEffect", "gekisouSkillID"),
        ("support-skills", "MasterSupportSkill", "MasterSupportSkillEffect", "supportSkillID"),
        ("gekisou-support-skills", "MasterGekisouSupportSkill", "MasterGekisouSupportSkillEffect", "gekisouSupportSkillID"),
    ]:
        effect_rows = exact(effects)
        skills[resource] = {str(row["_id"]): {
            "id": int(row["_id"]), "skillName": data.text(row.get("_nameTextID")),
            "description": data.text(row.get("_descriptionTextFormatID")),
            "effects": [effect for effect in effect_rows if effect.get(foreign) == row["_id"]],
            "sourceTable": table,
        } for row in data.rows(table)}
    characters = {str(row["_id"]): {"characterId": int(row["_id"]), "bandId": int(row.get("_bandID") or 0),
        "characterName": data.text(row.get("_nameTextID")), "colorCode": row.get("_mainColorCode")}
        for row in data.rows("MasterCharacter")}
    bands = {str(row["_id"]): {"bandId": int(row["_id"]), "bandName": data.text(row.get("_nameTextID"))}
        for row in data.rows("MasterBand")}
    band_items = {str(row["_id"]): {"bandItemId": int(row["_id"]), "bandId": int(row.get("_bandId") or 0),
        "name": data.text(row.get("_nameTextId")), "resourceGroupId": int(row.get("_resourceGroupId") or 0),
        "levels": [level for level in exact("MasterBandItemLevel") if level.get("bandItemId") == row["_id"]],
        "effects": [effect for effect in exact("MasterBandItemSkillEffect") if effect.get("bandItemId") == row["_id"]]}
        for row in data.rows("MasterBandItem")}
    scores = {row["_id"]: row for row in data.rows("MasterLiveMusicScore")}
    songs = {}
    for row in data.rows("MasterLiveMusic"):
        difficulties = []
        for index, name in enumerate(("easy", "normal", "hard", "expert", "special")):
            score_id = row.get(f"_{name}ID")
            score = scores.get(score_id)
            if score:
                difficulties.append({"difficulty": index, "difficultyName": name, "scoreId": score_id,
                    "playLevel": score.get("_musicScoreLevel"), "displayLevel": score.get("_musicScoreDisplayLevel"),
                    "noteCount": score.get("_fullComboCount"),
                    "file": data.asset(f"Assets/AddressableResources/Live/MusicScore/{score.get('_musicScoreTextFileName')}.bytes")})
        songs[str(row["_id"])] = {"musicId": row["_id"], "musicTitle": data.text(row.get("_titleTextID")),
            "bestMusicTagIds": row.get("_bestMusicTagIDs", []),
            "bandIds": row.get("_bandIDs", []), "musicType": row.get("_musicType"), "difficulty": difficulties,
            "liveScoreRankGroup": row.get("_liveScoreRankGroup"),
            "scoreRankRewardGroup": row.get("_scoreRankRewardGroup"), "comboRewardGroup": row.get("_comboRewardGroup"),
            "gekisou": {"missionTypes": [row.get(f"_gekisouMission{index}", 0) for index in (1, 2, 3)]}}
    events = {str(row["_id"]): {"id": row["_id"], "name": data.text(row.get("_nameTextId") or row.get("_nameTextID")),
        **{key.removeprefix("_"): value for key, value in row.items()}} for row in data.rows("MasterEvent")}
    event_tables = ("MasterEventEffect", "MasterEventPickUpCard", "MasterEventAchievementReward", "MasterEventRankingReward", "MasterLiveEventPoint")
    return {
        "schema": "haneoka-team-builder-source-v1", "server": data.server, "sourceId": source_id,
        "documents": {"cards": members, "support-cards": snapshots,
            "runtime-rules": {"schema": "haneoka-team-runtime-rules-v1", "server": data.server, "sourceId": source_id,
                "masterCharacterRoster": {"server": data.server, "sourceId": source_id,
                    "sourceTable": "MasterCharacter", "status": "complete" if "MasterCharacter" in data.tables else "missing",
                    "rows": exact("MasterCharacter")},
                "tables": {key: {"sourceTable": table, "status": "ready" if data.rows(table) else "empty" if table in data.tables else "missing", "rows": exact(table)}
                    for key, table in RUNTIME_TABLES.items()}},
            "characters": characters, "bands": bands, "band-items": {"items": band_items}, "songs": songs,
            "events": {"entries": events, "rules": {table: exact(table) for table in event_tables}},
            "gekisou": {key: exact(table) for key, table in {"luckBasePoints":"MasterLiveGekisouLuckBasePoint",
                "luckBonusLots":"MasterLiveGekisouLuckBonusLot","rankingScoreBonuses":"MasterLiveGekisouRankingScoreBonus",
                "rankRewards":"MasterGekisouLiveRankReward"}.items()},
            "skill-reference": {"conditions": exact("MasterSkillCondition"), "conditionSets": exact("MasterSkillConditionSet"),
                "targets": exact("MasterSkillTarget"), "cumulativeConditions": exact("MasterSkillCumulativeCondition")},
            "live-tools": {key: exact(table) for key, table in {
                "liveSettings": "MasterLiveSettings", "scoreRanks": "MasterLiveScoreRank",
                "judgementTiming": "MasterLiveJudgementTiming", "judgementParameters": "MasterLiveJudgementParameter",
                "noteParameters": "MasterLiveNoteParameter", "comboScoreBonuses": "MasterLiveComboScoreBonus",
                "liveBoostBonuses": "MasterLiveMusicBoostBonus", "challengeBoostBonuses": "MasterChallengeMusicBoostBonus",
                "expRewards": "MasterLiveMusicExpReward"}.items()},
            "progression": {key: exact(table) for key, table in TABLES.items()}, **skills},
        "sourceTables": ["MasterMemberCard", "MasterSupportCard", "MasterCharacter", *TABLES.values(), *RUNTIME_TABLES.values()],
    }
