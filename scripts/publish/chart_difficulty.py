"""Add only difficultyEstimate to an exact current chart/catalog projection."""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build.chart_difficulty import build_difficulty_estimates
from core.config import load_server_config
from core.contracts import SOURCE_INDEX_STORAGE_SCHEMA
from core.manifests import stable_json, write_json
from core.paths import validate_release_path
from core.storage import cas_key, fnv1a32_shard
from publish.band_descriptions import document, entry_json, publish
from publish.gacha_rates import raw_table
from publish.r2 import R2Store, _validate_release_manifest_for_gc
from verify.release import release_entries, write_release_identity_files

CONVERTER_SHA = "f8b473d7e376c8a04c782587a3ba52085a6c89a53e5f82dd0d5a0aa68561d9f9"
CALIBRATION_SHA = "51e6e168905d4b9fe355a671b2802e360f7e4835b2032bef8e697b5780d14969"


def difficulty_rows(song):
    rows = song.get("difficulty")
    if not isinstance(rows, list):
        raise ValueError("current full song requires singular difficulty list")
    for row in rows:
        if (not isinstance(row, dict) or type(row.get("difficulty")) is not int
                or type(row.get("scoreId")) is not int or row["scoreId"] <= 0
                or not isinstance(row.get("difficultyName"), str)):
            raise ValueError("current difficulty row lacks exact index/name/score FK")
    return rows


def patch_song_summary(original, estimates):
    # Existing summary projections may omit this full-entity field.
    return patch_song(original, estimates) if "difficulty" in original else copy.deepcopy(original)


def patch_song(original, estimates):
    updated = copy.deepcopy(original)
    for prior, row in zip(difficulty_rows(original), difficulty_rows(updated), strict=True):
        row["difficultyEstimate"] = copy.deepcopy(estimates.get(str(row["scoreId"])))
        if {k:v for k,v in row.items() if k != "difficultyEstimate"} != {k:v for k,v in prior.items() if k != "difficultyEstimate"}:
            raise ValueError("difficulty projection changed an official/score field")
    if {k:v for k,v in original.items() if k != "difficulty"} != {k:v for k,v in updated.items() if k != "difficulty"}:
        raise ValueError("difficulty projection changed unrelated song metadata")
    return updated


def patch_meta(original, song, estimates):
    updated = copy.deepcopy(original)
    for row in difficulty_rows(song):
        key = str(row["difficulty"])
        prior = original.get(key, {}).get("chart")
        if not isinstance(prior, dict):
            continue
        chart = updated[key]["chart"]
        chart["difficultyEstimate"] = copy.deepcopy(estimates.get(str(row["scoreId"])))
        if {k:v for k,v in chart.items() if k != "difficultyEstimate"} != {k:v for k,v in prior.items() if k != "difficultyEstimate"}:
            raise ValueError("difficulty projection overwrote nativeMeta/score/official fields")
    stripped = copy.deepcopy(updated)
    prior_stripped = copy.deepcopy(original)
    for row in difficulty_rows(song):
        key = str(row["difficulty"])
        for value in (stripped, prior_stripped):
            chart = value.get(key, {}).get("chart")
            if isinstance(chart, dict):chart.pop("difficultyEstimate", None)
    if stripped != prior_stripped:
        raise ValueError("difficulty projection changed unrelated song-meta fields")
    return updated


def prepare(store, config, identity, staging, inputs):
    if identity.get("server") != config.id or config.id not in {"intl", "jp"}:
        raise ValueError("difficulty current server mismatch")
    pointer_key = f"servers/{config.id}/current.json"
    head = store.head(pointer_key)
    pointer = document(store, pointer_key, 4096)
    if any(pointer.get(k) != identity[k] for k in ("releaseId", "sourceId")):
        raise ValueError("current changed before difficulty projection; refresh input")
    manifest_key = f"servers/{config.id}/releases/{identity['releaseId']}/release.json"
    if pointer.get("releaseManifest") != manifest_key:
        raise ValueError("invalid current manifest key")
    base = document(store, manifest_key)
    records = _validate_release_manifest_for_gc(base, manifest_key, config.id, identity["releaseId"])
    if base["sourceId"] != identity["sourceId"]:raise ValueError("difficulty base source mismatch")
    entries = {row["path"]:row for row in records}
    read_cache, metadata_bytes = {}, 0
    def read(path):
        nonlocal metadata_bytes
        if path not in read_cache:
            metadata_bytes += entries[path]["bytes"]
            if metadata_bytes > 64 * 1024 * 1024:raise ValueError("difficulty metadata closure exceeds budget")
            read_cache[path] = entry_json(store, entries[path], 16 * 1024 * 1024)
        return read_cache[path]
    catalog = read("api/v1/catalog/manifest.json")
    if catalog.get("server") != config.id or catalog.get("sourceId") != identity["sourceId"]:
        raise ValueError("difficulty catalog identity differs")
    descriptors = {resource:catalog["resources"][resource] for resource in ("songs", "song-meta")}
    for resource, descriptor in descriptors.items():
        if descriptor["index"] != f"api/v1/catalog/{resource}/index.json":raise ValueError("unexpected selected song index")
    songs = read(descriptors["songs"]["index"])
    if len(songs) != descriptors["songs"]["count"]:raise ValueError("current song coverage differs")
    # Full entities are authoritative; never infer chart coverage from a compact summary.
    song_entities = {}
    partition = descriptors["songs"]["entities"]
    if partition.get("algorithm") != "fnv1a32-mod-256" or partition.get("prefix") != "api/v1/catalog/songs/entities/":
        raise ValueError("unsupported current full song partition")
    for song_id in songs:
        shard = fnv1a32_shard(song_id)
        if shard not in partition["shards"]:raise ValueError("current full song partition absent")
        song_entities[song_id] = read(partition["prefix"] + shard + ".json")[song_id]
        difficulty_rows(song_entities[song_id])
    if not songs or not any(difficulty_rows(song) for song in song_entities.values()):
        raise ValueError("current full songs have no referenced chart coverage")
    tables = {}
    for name in ("MasterLiveMusic", "MasterLiveMusicScore"):
        entry = entries[f"game-client/master/{name}.bin"]
        tables[name] = raw_table(store, entry, name, config.master_crypto)
    music_rows = {str(row["_id"]):row for row in tables["MasterLiveMusic"]}
    score_rows = {int(row["_id"]):row for row in tables["MasterLiveMusicScore"]}
    source_manifest = read("metadata/source-index/manifest.json")
    if (source_manifest.get("schema") != SOURCE_INDEX_STORAGE_SCHEMA or source_manifest.get("server") != config.id
            or source_manifest.get("sourceId") != identity["sourceId"]):raise ValueError("chart source-index identity differs")
    parts = source_manifest["sources"]
    if parts.get("algorithm") != "fnv1a32-mod-256" or parts.get("prefix") != "metadata/source-index/sources/":
        raise ValueError("unsupported chart source-index partitions")
    files, selected_sources, missing, referenced = {}, {}, [], set()
    chart_bytes = 0
    for song_id, song in song_entities.items():
        music = music_rows[song_id]
        for row in difficulty_rows(song):
            score_id = int(row["scoreId"])
            if score_id != int(music.get("_" + row["difficultyName"] + "ID") or 0):
                raise ValueError("current score FK differs from original MasterLiveMusic")
            referenced.add(str(score_id))
            if len(referenced) > 2000:raise ValueError("current chart count exceeds producer budget")
            score = score_rows[score_id]
            logical = validate_release_path("Assets/AddressableResources/Live/MusicScore/" + str(score.get("_musicScoreTextFileName") or "") + ".bytes")
            path = "assets/" + logical
            if path not in entries:
                missing.append(str(score_id));continue
            shard = fnv1a32_shard(logical)
            if shard not in parts["shards"]:raise ValueError("declared chart source shard absent")
            source_row = read(parts["prefix"] + shard + ".json")[logical]
            output = next((o for o in source_row.get("outputs", []) if o.get("path") == path), None)
            entry = entries[path]
            if not output or output.get("sha256") != entry["sha256"] or not 0 < entry["bytes"] <= 2 * 1024 * 1024:
                raise ValueError("current chart entry differs from selected original output")
            selected_sources[logical] = source_row
            target = inputs / path
            if not target.is_file():
                chart_bytes += entry["bytes"]
                if chart_bytes > 64 * 1024 * 1024:raise ValueError("current chart byte closure exceeds budget")
                target.parent.mkdir(parents=True,exist_ok=True)
                store.download_file(cas_key(entry["sha256"]), target, expected_bytes=entry["bytes"], expected_sha256=entry["sha256"])
            files[str(score_id)] = target
    if not referenced or not files:
        raise ValueError("difficulty projection has no actual current chart input; not a valid noOp")
    write_json(inputs / "metadata/source-index.json", {"server":config.id,"sourceId":identity["sourceId"],"sources":selected_sources})
    # The existing chart_files producer is the sole converter/model runner; no _songs/score solver rebuild.
    estimates = build_difficulty_estimates(SimpleNamespace(root=inputs,server=config.id), identity["sourceId"], files, score_rows)
    for estimate in estimates.values():
        pin = estimate["pin"]
        if pin["canonicalConverterSha256"] != CONVERTER_SHA or pin["calibrationSha256"] != CALIBRATION_SHA:
            raise ValueError("producer differs from reviewed committed ccac calibration; no native gate bypass")
    selected = {}
    def select(path):
        if path not in selected:
            original = read(path);selected[path] = (original,copy.deepcopy(original))
        return selected[path][1]
    updated_songs = select(descriptors["songs"]["index"])
    updated_meta = select(descriptors["song-meta"]["index"])
    updated_song_entities, updated_meta_entities = {}, {}
    for song_id, song in song_entities.items():
        updated_songs[song_id] = patch_song_summary(songs[song_id],estimates)
        updated_meta[song_id] = patch_meta(updated_meta[song_id],song,estimates)
        for resource in ("songs", "song-meta"):
            partition = descriptors[resource]["entities"]
            if partition.get("algorithm") != "fnv1a32-mod-256" or partition.get("prefix") != f"api/v1/catalog/{resource}/entities/":
                raise ValueError("unsupported song entity partition")
            shard = fnv1a32_shard(song_id)
            if shard not in partition["shards"]:raise ValueError("selected current song partition absent")
            path = partition["prefix"] + shard + ".json";entity = select(path)
            entity[song_id] = patch_song(entity[song_id],estimates) if resource=="songs" else patch_meta(entity[song_id],song,estimates)
            (updated_song_entities if resource=="songs" else updated_meta_entities)[song_id] = copy.deepcopy(entity[song_id])
    for relation in descriptors["songs"].get("relations", {}).values():
        if relation.get("valueMode","records") != "records":continue
        if relation.get("algorithm") != "fnv1a32-mod-256" or not relation.get("prefix", "").startswith("api/v1/catalog/songs/relations/"):
            raise ValueError("unsupported song relation partition")
        for shard in relation["shards"]:
            value = select(relation["prefix"]+shard+".json")
            for group in value.values():
                for song_id,summary in group.items():
                    if song_id in songs:group[song_id]=patch_song_summary(summary,estimates)
    for resource in ("songs", "song-meta"):
        legacy = f"api/{resource}.json"
        if legacy in entries:
            value = select(legacy)
            for song_id,song in song_entities.items():
                value[song_id]=patch_song(value[song_id],estimates) if resource=="songs" else patch_meta(value[song_id],song,estimates)
    allowed = {p for p,(old,new) in selected.items() if old!=new}
    for path in allowed:write_json(staging/path,selected[path][1])
    changed = release_entries(staging)
    if {r["path"] for r in changed} != allowed:raise ValueError("difficulty projection escaped selected JSON entries")
    reused = [r for r in records if r["path"] not in allowed]
    result = {"pointer":pointer,"pointerETag":head["ETag"],"sourceId":identity["sourceId"],"noOp":not changed,
              "changedEntries":changed,"reusedEntryCount":len(reused),"estimates":estimates,"songs":updated_songs,
              "songMeta":updated_meta,"songEntities":updated_song_entities,"songMetaEntities":updated_meta_entities,"missingChartScoreIds":sorted(set(missing)),"referencedScoreCount":len(referenced),
              "materializedChartCount":len(files),"chartBytes":chart_bytes,"metadataBytes":metadata_bytes,
              "masterSHA256":{name:entries[f"game-client/master/{name}.bin"]["sha256"] for name in tables}}
    if changed:
        manifest = write_release_identity_files(staging,config.id,identity["sourceId"],sorted(reused+changed,key=lambda r:r["path"]))
        checked = _validate_release_manifest_for_gc(manifest,f"servers/{config.id}/releases/{manifest['releaseId']}/release.json",config.id,manifest["releaseId"])
        if {r["path"]:r for r in checked if r["path"] not in allowed} != {r["path"]:r for r in reused}:
            raise ValueError("unrelated release CAS entry changed")
        result["manifest"]=manifest
    return result


def verify_public(receipt,prepared,output):
    proofs=[]
    # One new valid ccac case plus explicitly unavailable rows when present; no old solver/UI matrices.
    ids=[s for s in ("100070","100005","100012","100075") if s in prepared["songEntities"]]
    for song_id in ids:
        for resource,key in (("songs","songEntities"),("song-meta","songMetaEntities")):
            url=f"https://haneoka.org/api/v1/servers/{receipt['server']}/{resource}/{song_id}?release={receipt['releaseId']}"
            with urlopen(Request(url,headers={"User-Agent":"Mozilla/5.0","Accept":"application/json"}),timeout=30) as r:
                if r.status!=200 or r.headers.get("X-Haneoka-Release-Id")!=receipt["releaseId"] or r.headers.get("X-Haneoka-Source-Id")!=receipt["sourceId"]:
                    raise ValueError("difficulty public readback pin differs")
                raw=r.read(2*1024*1024+1)
                if len(raw)>2*1024*1024 or json.loads(raw)!=prepared[key][song_id]:
                    raise ValueError("difficulty current entity differs from preserved prepared JSON")
                proofs.append({"path":f"{resource}/{song_id}","HTTP":r.status,"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest()})
    write_json(output/"public-readback.json",proofs)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--output",type=Path,required=True);args=parser.parse_args()
    pin=os.environ["PRODUCER_PIN"]
    if not re.fullmatch(r"[a-f0-9]{40}",pin) or subprocess.check_output(["git","rev-parse","HEAD"],text=True).strip()!=pin:raise ValueError("difficulty producer pin mismatch")
    packed=os.environ["DIFFICULTY_CURRENT_IDENTITY_JSON"]
    if len(packed.encode())>4096:raise ValueError("difficulty input size cap")
    identity=json.loads(packed)
    if identity["server"]!=os.environ["RESOURCE_SERVER"]:raise ValueError("difficulty source/environment mismatch")
    config=load_server_config(identity["server"]);store=R2Store(config,concurrency=4);args.output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="current-chart-difficulty-") as temp:
        root=Path(temp);prepared=prepare(store,config,identity,root/"release",root/"inputs")
        quality=Counter(e["quality"]["status"] for e in prepared["estimates"].values());valid=sum(e["estimatedConstant"] is not None for e in prepared["estimates"].values())
        receipt={"schema":"haneoka-current-chart-difficulty-publication-v1","producerPin":pin,"server":config.id,"sourceId":identity["sourceId"],
                 "baseReleaseId":identity["releaseId"],"published":False,"promoted":False,"noOp":prepared["noOp"],
                 "canonicalConverterSha256":CONVERTER_SHA,"calibrationSha256":CALIBRATION_SHA,"qualityCounts":dict(quality),
                 "validCount":valid,"nullCount":prepared["referencedScoreCount"]-valid,"referencedScoreCount":prepared["referencedScoreCount"],
                 "materializedChartCount":prepared["materializedChartCount"],"missingChartScoreIds":prepared["missingChartScoreIds"],
                 "chartBytes":prepared["chartBytes"],"metadataBytes":prepared["metadataBytes"],"originalMasterSHA256":prepared["masterSHA256"],
                 "nativeMetaScoresAndOfficialFieldsPreserved":True,"rawAPIBuildRun":False,"pipelineFingerprintPreserved":True,"reusedEntries":prepared["reusedEntryCount"],
                 "selectedEstimates":{k:prepared["estimates"].get(k) for k in ("10007003","10000501","10001201","10007503")}}
        if not prepared["noOp"]:
            receipt.update({"releaseId":prepared["manifest"]["releaseId"],"changedPaths":[r["path"] for r in prepared["changedEntries"]],"changedBytes":sum(r["bytes"] for r in prepared["changedEntries"])})
            if os.environ.get("PUBLISH")=="true":receipt["pointer"]=publish(store,config,prepared,root/"release");receipt.update({"published":True,"promoted":True})
        else:receipt["releaseId"]=identity["releaseId"]
        write_json(args.output/"publication-receipt.json",receipt)
        if receipt["published"] or receipt["noOp"]:
            if store.get_json(f"servers/{config.id}/current.json")["releaseId"]!=receipt["releaseId"]:raise ValueError("difficulty current changed after promotion")
            verify_public(receipt,prepared,args.output)
        if receipt["published"] and os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"],"a") as out:out.write("release_promoted=true\n")
    print(stable_json(receipt))


if __name__=="__main__":main()
