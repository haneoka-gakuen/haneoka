# L3 — GEB
# Input: Release-owned stage and monitor Unity objects and their media outputs.
# Output: Shared and per-band scene descriptors for the chart viewer.
# Pos: [Map](L2-2.md); live background resource projection.
# Effects/Dependencies: Reuses published sprites and preserves the source transform hierarchy.

from __future__ import annotations

from build.unity_effect import _mesh
from core.manifests import write_json

LIVE = "Assets/AddressableResources/Live/Prefabs/Live/Live.prefab"
BANDS = "Assets/AddressableResources/Band/"
DIRECTORS = "Assets/AddressableResources/Live/Prefabs/LiveBackground"
OUTPUT = "runtime/live-stage/v1"

def components(records, obj):
    return [records[str(row["component"]["m_PathID"])] for row in obj["data"]["m_Component"]]


def script(record):
    return record["data"].get("m_Script", {}).get("reference", {}).get("name")


def vector(value, axes="xyz"):
    return [value[axis] for axis in axes]


def shape(vertices, uvs, indices):
    return {"positions": vertices, "uvs": uvs, "indices": indices}


def quad(left, bottom, right, top):
    return shape([left, bottom, 0, right, bottom, 0, left, top, 0, right, top, 0],
                 [0, 0, 1, 0, 0, 1, 1, 1], [0, 1, 2, 2, 1, 3])


def sprite_shape(raw, flip_x, flip_y):
    rect = raw["m_Rect"]
    pivot = raw["m_Pivot"]
    width, height = rect["width"] / raw["m_PixelsToUnits"], rect["height"] / raw["m_PixelsToUnits"]
    left, bottom = -pivot["x"] * width, -pivot["y"] * height
    mesh = quad(left, bottom, left + width, bottom + height)
    for i in range(0, len(mesh["positions"]), 3):
        if flip_x:
            mesh["positions"][i] *= -1
        if flip_y:
            mesh["positions"][i + 1] *= -1
    return mesh


def mirrored_backdrop(raw):
    rect = raw["m_Rect"]
    width = rect["width"] / raw["m_PixelsToUnits"]
    height = rect["height"] / raw["m_PixelsToUnits"]
    bottom = -raw["m_Pivot"]["y"] * height
    # The source image ends at the centre seam. Both halves meet at its right edge.
    left = quad(-width, bottom, 0, bottom + height)
    right = quad(0, bottom, width, bottom + height)
    return shape(
        left["positions"] + right["positions"],
        left["uvs"] + [1, 0, 0, 0, 1, 1, 0, 1],
        left["indices"] + [index + 4 for index in right["indices"]],
    )


def sprite_pass(data, pointer, owner, renderer, group, flip_x=False, mirror_backdrop=False):
    entry = data.unity_object(pointer, owner, "Sprite")
    if not entry:
        return None
    raw = entry["data"]
    color = renderer.get("m_Color", {"r": 1, "g": 1, "b": 1, "a": 1})
    return {
        **(mirrored_backdrop(raw) if mirror_backdrop else sprite_shape(raw, flip_x, bool(renderer.get("m_FlipY")))),
        "texture": data.unity_output_url(pointer, owner, "Sprite"),
        "tint": vector(color, "rgba"),
        "order": renderer.get("m_SortingOrder", 0),
        "group": group,
    }


def follow(nodes, pointer):
    return nodes[str(pointer["m_PathID"])]


def walk(records, current, prefix=""):
    raw = current["data"]
    obj = follow(records, raw["m_GameObject"])
    name = obj["data"]["m_Name"]
    path = f"{prefix}/{name}" if prefix else name
    yield path, current, obj
    for child in raw["m_Children"]:
        yield from walk(records, follow(records, child), path)


def transform(records, obj):
    return next(row for row in components(records, obj) if row["type"] in {"Transform", "RectTransform"})


def game_object(records, name):
    matches = [record for record in records.values() if record["type"] == "GameObject" and record["data"]["m_Name"] == name]
    if len(matches) != 1:
        raise ValueError(f"Expected one live scene node named {name}, found {len(matches)}")
    return matches[0]


def pose(raw):
    return {
        "position": vector(raw["m_LocalPosition"]),
        "rotation": vector(raw["m_LocalRotation"], "xyzw"),
        "scale": vector(raw["m_LocalScale"]),
    }


def flatten_nodes(records, start):
    result = []
    indexes = {}
    for path, row, obj in walk(records, start):
        indexes[row["pathId"]] = len(result)
        result.append({
            "name": obj["data"]["m_Name"],
            "parent": indexes.get(str(row["data"]["m_Father"]["m_PathID"]), -1),
            "active": obj["data"]["m_IsActive"],
            **pose(row["data"]),
        })
    return result, indexes


def mesh_pass(data, mesh_pointer, owner):
    if not mesh_pointer or not int(mesh_pointer.get("m_PathID", 0)):
        return None
    # Unity's shared builtin Quad is the geometry used by the video renderer
    # and stencil planes. Other planes come from serialized mesh vertices.
    if int(mesh_pointer["m_PathID"]) == 10210:
        return quad(-0.5, -0.5, 0.5, 0.5)
    record = data.unity_object(mesh_pointer, owner, "Mesh")
    view = _mesh(record["pathId"], record, owner)
    if not view["indices"] or not view["positions"]:
        return None
    return shape(view["positions"], view["uvs"], view["indices"])


def material_shader(data, pointer, owner):
    material = data.unity_object(pointer, owner, "Material")
    if material:
        return material["data"].get("m_Shader", {}).get("reference", {}).get("name")
    return None


def band_scene(data, source):
    descriptor, records = data.source_objects(source)
    owner = descriptor["serializedFile"]
    root = transform(records, follow(records, {"m_PathID": descriptor["rootObjects"][0]}))
    nodes, indices = flatten_nodes(records, root)
    passes = []
    for _, current, obj in walk(records, root):
        for entry in components(records, obj):
            raw = entry["data"]
            if script(entry) == "LiveStageSetBackdrop":
                draw = sprite_pass(data, raw["_sprite"], owner, {}, "stage", mirror_backdrop=bool(raw["_isMirroring"]))
                draw["order"] = raw["_sortingOrder"]
                draw["shader"] = material_shader(data, raw["_material"], owner)
            elif script(entry) == "StencilMaskMaterialApplier":
                mesh_filter = next(row["data"] for row in components(records, obj) if row["type"] == "MeshFilter")
                draw = mesh_pass(data, mesh_filter["m_Mesh"], owner)
                if draw is not None:
                    draw.update(group="stencil", order=-100, stencil=raw["_stencilRef"])
            elif entry["type"] == "SpriteRenderer":
                draw = sprite_pass(data, raw["m_Sprite"], owner, raw, "stage", bool(raw["m_FlipX"]))
            else:
                continue
            if draw is not None:
                passes.append({**draw, "node": indices[current["pathId"]]})
    logo_source = source.split("/live_stage/", 1)[0] + "/band_logo.png"
    logo = None
    if logo_source in data.source_index:
        logo_descriptor, logo_records = data.source_objects(logo_source)
        sprite = next((
            str(path_id) for path_id in logo_descriptor["rootObjects"]
            if logo_records[str(path_id)]["type"] == "Sprite"
        ), None)
        if sprite is not None:
            logo = sprite_pass(
                data, {"m_FileID": 0, "m_PathID": sprite}, logo_descriptor["serializedFile"], {}, "band-logo",
            )
    return {"nodes": nodes, "passes": passes, "logo": logo}


def common_scene(data):
    descriptor, records = data.source_objects(LIVE)
    owner = descriptor["serializedFile"]
    root = transform(records, game_object(records, "LiveBackgroundView"))
    nodes, indices = flatten_nodes(records, root)
    live = next(item["data"] for item in components(records, game_object(records, "LiveBackgroundView"))
                if script(item) == "LiveBackgroundView")
    monitor = follow(records, live["_monitor"])["data"]
    logo_ids = {
        str(follow(records, monitor[field])["data"]["_logoRenderer"]["m_PathID"])
        for field in ("_leftMonitor", "_rightMonitor")
    }
    video = follow(records, monitor["_usmVideoRenderer"])["data"]
    video_ids = {str(entry["m_PathID"]) for entry in [video["_renderer"], *video["_optionalRenderers"]]}
    jacket_id = str(monitor["_jacketRenderer"]["m_PathID"])
    blur_id = str(monitor["_blurJacketRenderer"]["m_PathID"])
    mount = transform(records, follow(records, live["_liveSrageRoot"]))
    slots = []
    for pointer in live["_characters"]:
        character = follow(records, pointer)["data"]
        anchors = follow(records, character["_anchors"])["data"]
        renderer = follow(records, character["_renderer"])["data"]
        display = follow(records, renderer["m_GameObject"])
        node = transform(records, display)
        mesh = next(row["data"]["m_Mesh"] for row in components(records, display) if row["type"] == "MeshFilter")
        slots.append({
            "node": indices[node["pathId"]],
            "geometry": mesh_pass(data, mesh, owner),
            "monitorAnchors": [
                indices[str(anchors[field]["m_PathID"])] for field in ("_faceAnchor", "_bodyAnchor")
            ],
            "position": vector(character["_live2DCharacterPosition"]),
            "scale": character["_live2DCharacterScale"],
            "order": character["_live2DSortingOrder"],
        })
    camera_obj = game_object(records, "StageCamera")
    camera = next(item["data"] for item in components(records, camera_obj) if item["type"] == "Camera")
    controller = follow(records, live["_cameraController"])["data"]
    passes = []
    for path, current, obj in walk(records, root):
        if not ("/LiveBackgroundMonitor/" in path or "/LightController/" in path):
            continue
        items = components(records, obj)
        trapezium = next((r["data"] for r in items if script(r) == "CreateTrapeziumMesh"), None)
        member_monitor = next((r["data"] for r in items if script(r) == "LiveMonitorCharacterMesh"), None)
        for entry in items:
            raw = entry["data"]
            if not raw.get("m_Enabled"):
                continue
            if entry["pathId"] in video_ids:
                if trapezium is not None:
                    corners = [v for name in ("_leftLowerOffset", "_rightLowerOffset", "_leftUpperOffset", "_rightUpperOffset")
                               for v in vector(trapezium[name])]
                    draw = shape(corners, [0, 0, 1, 0, 0, 1, 1, 1], [0, 1, 2, 2, 1, 3])
                else:
                    mesh_filter = next(row["data"] for row in items if row["type"] == "MeshFilter")
                    draw = mesh_pass(data, mesh_filter["m_Mesh"], owner)
                if draw is not None:
                    draw.update(group="video", order=video["_sortingOrder"] if not trapezium else raw["m_SortingOrder"])
            elif member_monitor and entry["type"] == "MeshRenderer":
                mesh_filter = next(row["data"] for row in items if row["type"] == "MeshFilter")
                draw = mesh_pass(data, mesh_filter["m_Mesh"], owner)
                if draw is not None:
                    size = member_monitor["_size"]
                    draw.update(group="member-monitor", order=raw["m_SortingOrder"],
                                slot=int(obj["data"]["m_Name"].rsplit("(", 1)[1][:-1]) - 1,
                                monitorAspect=size["x"] / size["y"],
                                stencil=member_monitor["_stencil"] if member_monitor["_compareFunction"] == 3 else None)
            elif entry["type"] == "SpriteRenderer":
                if entry["pathId"] in logo_ids:
                    draw = quad(-0.5, -0.5, 0.5, 0.5)
                    draw.update(group="band-logo", order=raw["m_SortingOrder"])
                elif entry["pathId"] in (jacket_id, blur_id):
                    size = raw["m_Size"]
                    draw = quad(-size["x"] / 2, -size["y"] / 2, size["x"] / 2, size["y"] / 2)
                    draw.update(group="jacket" if entry["pathId"] == jacket_id else "blur-jacket", order=raw["m_SortingOrder"])
                else:
                    draw = sprite_pass(data, raw["m_Sprite"], owner, raw, "scene", bool(raw["m_FlipX"]))
                    if draw and raw["m_Materials"]:
                        draw["shader"] = material_shader(data, raw["m_Materials"][0], owner)
            else:
                continue
            if draw is not None:
                passes.append({**draw, "node": indices[current["pathId"]]})
    # Live2DModelRenderTextureCreator creates this orthographic camera at runtime.
    capture = {"cameraPosition": [0, 2.299999952316284, -2], "halfHeight": 3.5,
               "nearClip": 0.009999999776482582, "farClip": 50}
    return {"nodes": nodes, "passes": passes, "slots": slots, "mount": indices[mount["pathId"]], "capture": capture,
            "camera": {"node": indices[transform(records, camera_obj)["pathId"]],
                       "fov": camera["field of view"], "near": camera["near clip plane"], "far": camera["far clip plane"],
                       "maxAspect": controller["_pillarboxThresholdAspect"] if controller["_clampViewport"] else 0}}


def camera_profile(data, level):
    source = f"{DIRECTORS}/live_background_director_{level}.prefab"
    descriptor, records = data.source_objects(source)
    owner = descriptor["serializedFile"]
    _, director = next((row, row["data"]) for row in records.values() if row["type"] == "PlayableDirector")
    references = dict(director["m_ExposedReferences"]["m_References"])
    timeline = data.unity_object(director["m_PlayableAsset"], owner, "MonoBehaviour")
    track_owner = timeline["serializedFile"]
    tracks = [data.unity_object(pointer, track_owner, "MonoBehaviour") for pointer in timeline["data"]["m_Tracks"]]
    track = next(row for row in tracks if script(row) == "CinemachineTrack")
    nodes, indexes = flatten_nodes(records, transform(records, follow(records, {"m_PathID": descriptor["rootObjects"][0]})))
    clips = []
    for clip in sorted(track["data"]["m_Clips"], key=lambda row: row["m_Start"]):
        shot = data.unity_object(clip["m_Asset"], track["serializedFile"], "MonoBehaviour")["data"]
        binding = references.get(shot["VirtualCamera"]["exposedName"], shot["VirtualCamera"]["defaultValue"])
        if not binding["m_PathID"]:
            raise ValueError(f"Live camera shot has no exposed target: {source}")
        camera = follow(records, binding)["data"]
        target = transform(records, follow(records, camera["m_GameObject"]))
        blend = []
        for suffix in ("In", "Out"):
            duration = clip[f"m_Blend{suffix}Duration"]
            if duration < 0:
                duration = clip[f"m_Ease{suffix}Duration"]
            curve = clip[f"m_Mix{suffix}Curve"]["m_Curve"]
            blend.append({"duration": duration, "keys": [
                vector(row, ("time", "value", "inSlope", "outSlope", "inWeight", "outWeight", "weightedMode"))
                for row in curve
            ]})
        lens = camera["Lens"]
        clips.append({"start": clip["m_Start"], "duration": clip["m_Duration"], "node": indexes[target["pathId"]],
                      "fov": lens["FieldOfView"], "near": lens["NearClipPlane"], "far": lens["FarClipPlane"],
                      "blendIn": blend[0], "blendOut": blend[1]})
    return {"nodes": nodes, "clips": clips, "duration": max(clip["start"] + clip["duration"] for clip in clips),
            "wrapMode": director["m_WrapMode"]}


def song_stage_profiles(data, video_records):
    variants = {(row["_stageID"], row["_vjVideoPattern"]): str(row["_videoID"])
                for row in data.rows("MasterLiveStageVideo")}
    output = {}
    for song in data.rows("MasterLiveMusic"):
        row = {"camera": song["_backgroundCameraType"]}
        pattern = song.get("_vjVideoPattern")
        videos = {str(band): video_records.get(identity, {}).get("playableUrl")
                  for (band, key), identity in variants.items() if key == pattern}
        row["videos"] = {band: path for band, path in videos.items() if path}
        output[str(song["_id"])] = row
    return output


def build_live_stage(data, characters, models, video_records, output=None):
    if LIVE not in data.source_index:
        return 0
    output = output or data.root / OUTPUT
    common = common_scene(data)
    write_json(output / "common.json", common)
    bands = [path for path in data.source_paths if path.startswith(BANDS) and path.endswith("/live_stage/live_stage.prefab")]
    for path in bands:
        band = path[len(BANDS):].split("/")[0]
        write_json(output / f"band-{band}.json", band_scene(data, path))
    lineup = {}
    performers = {}
    acting = {row["_characterID"]: row for row in data.rows("MasterLiveCharacterOption")}
    for character in characters.values():
        if character.get("characterType") == "unique" and character.get("bandId"):
            performers.setdefault(character["bandId"], []).append(character)
    for band, members in performers.items():
        if sorted(member["displayOrder"] for member in members) != list(range(1, len(common["slots"]) + 1)):
            continue
        entries = []
        for member in sorted(members, key=lambda row: row["displayOrder"]):
            name = f'{int(member["characterId"]):03d}_live-mode_live_01'
            default = models.get(name, {}).get("runtime", {}).get("model")
            low = models.get(name + "_low", {}).get("runtime", {}).get("model")
            if not default:
                break
            options = acting.get(member["characterId"])
            placement = {"offset": [options["_offsetX"], options["_offsetY"]], "scale": options["_scale"]} if options else {}
            entries.append({"standard": default, **({"low": low} if low else {}), **placement})
        if len(entries) == len(common["slots"]):
            lineup[str(band)] = entries
    write_json(output / "lineup.json", lineup)
    write_json(output / "songs.json", song_stage_profiles(data, video_records))
    for level in ("low", "mid", "high"):
        if f"{DIRECTORS}/live_background_director_{level}.prefab" in data.source_index:
            write_json(output / f"camera-{level}.json", camera_profile(data, level))
    return len(bands)
