"""effect001Simple for every note kind, as native Sonolus particles.

Prefabs per kind come from effect001simple/LiveNoteEffectAssetSettings: Normal, Slide, Flick, FlickLeft,
FlickRight, FlickJust (groove), SlideLoop, SlideLoopConnect (= slide). Frames and walls use simple.py; ground-circle
dot bursts use the engine's random draws (simple.build_dots); every other emitter (flick sweeps and sparks, the
hold loop) is simulated deterministically (gsim.py) and each simulated particle becomes one native particle whose
position, size and brightness are fitted with the engine's eases."""
import gzip, json, math, os, sys
import numpy as np
from PIL import Image
import cam
import simple as S
import spec
from gsim import Prefab, simulate
from compose import fit_segments, ease_fn

ROOT = "/home/xuc/.claude/jobs/50d4d325/tmp/fxre/out/effect001simple"
NORMAL_CLIPS = {5: "note_simple_perfect", 4: "note_simple_great", 3: "note_simple_good", 2: "note_simple_bad"}
SLIDE_CLIPS = {5: "note_slide_simple_parfect", 4: "note_slide_simple_great", 3: "note_slide_simple_good", 2: "note_slide_simple_bad"}
FLICK_CLIPS = {5: "tap_flick_simple_perfect", 4: "tap_flick_simple_great", 3: "tap_flick_simple_good", 2: "tap_flick_simple_bad"}
# Engine kinds: 0 normal, 1 just, 2 slide, 3 connect, 4 flick, 5 flick left, 6 flick right.
KINDS = [("note_normal_simple", NORMAL_CLIPS), ("note_groove_simple", NORMAL_CLIPS), ("note_slide_simple", SLIDE_CLIPS),
         ("note_slide_simple", SLIDE_CLIPS), ("note_flick_simple", FLICK_CLIPS), ("note_flick_left_simple", FLICK_CLIPS),
         ("note_flick_right_simple", FLICK_CLIPS)]
LOOP = ("note_slide_simple_loop", "note_slide_simple_loop")
LOOP_PERIOD = 0.5
PEAK_SHARE = 1.0  # set per emitter: flickering discs read at ~.6 of their peak, star sparks at their peak
LOOP_KEEP = 0.35  # the hold stream emits ~470 dots/s; half of them read the same at these sizes
TEXTURES = {"ef_tap_normal_glow": "TEX_ef_tap_particle_star.png", "ef_tap_normal_long_glow": "TEX_ef_tap_particle_star_long.png", "note_point_simple": "TEX_ef_circle_icon.png"}
TINTS = {"ef_tap_normal_glow": (2.996, 2.996, 2.996, 0.616), "ef_tap_normal_long_glow": (3.0, 3.0, 3.0, 0.49), "note_point_simple": (1.151, 1.151, 1.151, 1.0)}
EASES = ["linear", "inQuad", "outQuad", "inOutQuad", "inCubic", "outCubic", "inExpo", "outExpo", "inSine", "outSine"]


def material_of(prefab, path):
    mats = [f for f in os.listdir(f"{ROOT}/{prefab}") if f.startswith("MAT_")]
    node = json.load(open(f"{ROOT}/{prefab}/{prefab}__root__{path.replace('/', '__')}.json"))
    rend = [c for c in node["components"] if c["type"] == "ParticleSystemRenderer"][0]["tree"]
    pid = rend["m_Materials"][0]["m_PathID"]
    # The dump keeps material files by name only; resolve by matching texture usage per emitter kind.
    name = "ef_tap_normal_long_glow" if "ef_splash" in path.split("/")[-1] and "02" not in path and "flick" in prefab and "move" in path else None
    if name is None:
        name = "note_point_simple" if "slide_simple_loop" in prefab or "point_center" in path or ("ef_particle_point" in path and "flick" not in prefab) else "ef_tap_normal_glow"
    return name


_tex = {}


def texture(name):
    if name not in _tex:
        for d in os.listdir(ROOT):
            p = f"{ROOT}/{d}/{TEXTURES[name]}"
            if os.path.exists(p):
                _tex[name] = np.asarray(Image.open(p).convert("RGBA")).astype(float) / 255
                break
    return _tex[name]


def whiten(e):
    """HDR additive emission -> displayable additive colour: saturating per channel, and overbright cores turn
    white (what the game's HDR bloom shows), with a moderate halo from the overflow."""
    from scipy.ndimage import gaussian_filter
    d = 1 - np.exp(-e)
    over = np.clip(e.max(axis=2) - 1.0, 0, None)
    white = np.clip(over / 1.5, 0, 1)[..., None]
    d = d + (1 - d) * white * 0.92
    halo = sum(w * gaussian_filter(over, s, mode="constant") for s, w in ((4, 0.35), (12, 0.2)))
    tint = e / np.maximum(e.max(axis=(0, 1), keepdims=True).max(axis=2, keepdims=True), 1e-6)
    hue = e.reshape(-1, 3).max(axis=0); hue = hue / max(hue.max(), 1e-6)
    d = np.clip(d + (1 - np.exp(-halo))[..., None] * (0.35 + 0.65 * hue)[None, None], 0, 1)
    return d


def sprite_tile(pk, mat, gain, px_h, aspect):
    """Texture of `mat` at a reference screen height (px) times its HDR gain, whitened, with a halo."""
    key = ("sprite", mat, tuple(np.round(gain, 3)), round(px_h), round(aspect, 2))
    if key in pk.keys:
        return pk.keys[key], pk.grow[key][0], pk.grow[key][1]
    from bake import sample
    tex = texture(mat)
    h = max(4, int(round(px_h)))
    w = max(4, int(round(h * aspect)))
    pad = 32
    t = sample(tex, (0, 0, 1, 1), w, h)
    e = np.pad(t[..., :3] * t[..., 3:4] * np.asarray(gain)[None, None], ((pad, pad), (pad, pad), (0, 0)))
    # LiveGameVolume bloom at screen scale, then the HDR result whitened into displayable colour.
    import bake as B
    B.SIGMAS = [1, 7, 15, 31, 62]
    B.WEIGHTS = [(1 - B.SCATTER) * B.SCATTER ** i if i < 4 else B.SCATTER ** i for i in range(5)]
    B.INTENSITY = 5.0
    disp = whiten(B.bloom(e, (1.0, 1.0)))
    target = S.srgb(S.lin(S.BG)[None, None] + S.lin(disp))
    a = np.max(np.clip((target - S.BG) / np.maximum(1 - S.BG, 1e-3), 0, 1), axis=2)
    rgb = np.where(a[..., None] > 1e-5, np.clip((target - S.BG * (1 - a[..., None])) / np.maximum(a[..., None], 1e-5), 0, 1), 0)
    img = (np.concatenate([rgb, a[..., None]], 2) * 255).round().astype(np.uint8)
    sid = pk.tile(img, key)
    if not hasattr(pk, "grow"):
        pk.grow = {}
    pk.grow[key] = ((w + 2 * pad) / w, (h + 2 * pad) / h)
    return sid, pk.grow[key][0], pk.grow[key][1]


def quad_for(tracks, W):
    """A world rectangle covering the tracks: vertical (z fixed) unless the particles travel in depth, then a
    ground band at their mean height. Returns (kind, corners as transform input, stage corner function)."""
    pts = np.array([q[1:4] for tr in tracks for q in tr])
    sz = np.array([max(q[4], q[5]) for tr in tracks for q in tr])
    m = sz.max() * 0.75 + 0.2
    x0, x1 = pts[:, 0].min() - m, pts[:, 0].max() + m
    if pts[:, 2].max() - pts[:, 2].min() > 1.5:
        y = float(np.median(pts[:, 1]))
        z0, z1 = pts[:, 2].min() - m, pts[:, 2].max() + m
        corners = [((x0, 0), y, S.JZ + z0), ((x0, 0), y, S.JZ + z1), ((x1, 0), y, S.JZ + z1), ((x1, 0), y, S.JZ + z0)]
    else:
        z = float(np.median(pts[:, 2]))
        y0, y1 = pts[:, 1].min() - m, pts[:, 1].max() + m
        corners = [((x0, 0), y0, S.JZ + z), ((x0, 0), y1, S.JZ + z), ((x1, 0), y1, S.JZ + z), ((x1, 0), y0, S.JZ + z)]
    return corners


def stage_of(X, Y, Z):
    k = S.KX / (S.H * S.S - Y * S.S + Z * S.C)
    return np.array((X * k, S.stage_y(Y, Z)))


def inverse_bilinear(p, c):
    """(u, v) in [-1, 1] with bilinear(c)(u, v) = p; c = bl, tl, tr, br (stage)."""
    u, v = 0.0, 0.0
    for _ in range(30):
        a, b = (u + 1) / 2, (v + 1) / 2
        bot = c[0] + (c[3] - c[0]) * a; top = c[1] + (c[2] - c[1]) * a
        q = bot + (top - bot) * b
        du = ((c[3] - c[0]) * (1 - b) + (c[2] - c[1]) * b) / 2
        dv = (top - bot) / 2
        J = np.array([du, dv]).T
        step = np.linalg.lstsq(J, p - q, rcond=None)[0]
        step = np.clip(step, -0.5, 0.5)
        u, v = u + step[0], v + step[1]
        if abs(step).max() < 1e-7:
            break
    return u, v, np.linalg.norm(du), np.linalg.norm(dv)


def fit(values, times, tol):
    """Single eased segment if it fits within tol, else up to 3 segments: [(t0, t1, v0, v1, ease)]."""
    if len(values) < 2:
        return [(times[0], times[-1], values[0], values[-1], "linear")]
    span = max(1e-6, max(values) - min(values))
    segs = fit_segments([v for v in values], list(range(len(values))), len(values) - 1, tol=tol * span)
    if len(segs) > 2:
        # Two segments split at the largest change of direction keep motion and fade readable.
        mid = max(range(1, len(values) - 1), key=lambda i: abs(values[i] - (values[0] + (values[-1] - values[0]) * i / (len(values) - 1))))
        n = len(values) - 1
        segs = [(0, mid / n, values[0], values[mid], "linear"), (mid / n, 1, values[mid], values[-1], "linear")]
    return [(times[0] + s0 * (times[-1] - times[0]), times[0] + s1 * (times[-1] - times[0]), v0, v1, e) for s0, s1, v0, v1, e in segs]


def envelope(xs, k=5, mode="mean"):
    out = []
    for i in range(len(xs)):
        w = xs[max(0, i - k): i + k + 1]
        out.append(max(w) * PEAK_SHARE if mode == "peak" else sum(w) / len(w))
    return out


def tracks_to_particles(pk, tracks, mat, gain, flicker, corners_world, duration, offset=0.0, max_px=None):
    c = [stage_of(X, Y, Z) for (X, _), Y, Z in [((xa, xb), Y, Z) for (xa, xb), Y, Z in corners_world]]
    # Reference sprite: the large end of the apparent screen heights (flicker envelope), so the texture keeps its
    # shape when drawn at full size; never below 32 px.
    sizes_px, ratios = [], []
    for tr in tracks:
        env = envelope([q[5] for q in tr], 6, "peak" if flicker else "mean")
        envx = envelope([q[4] for q in tr], 6, "peak" if flicker else "mean")
        for (t, X, Y, Z, sx, sy, br), e, ex in list(zip(tr, env, envx))[:: max(1, len(tr) // 6)]:
            sizes_px.append(e * (S.stage_px(0, Y, S.JZ + Z)[1] - S.stage_px(0, Y + 0.01, S.JZ + Z)[1]) / 0.01)
            if e > 1e-4:
                ratios.append(ex / e)
    ref_px = max(32.0, float(np.percentile(sizes_px, 85)))
    aspect = float(np.median(ratios)) if ratios else 1.0
    sid, gx, gy = sprite_tile(pk, mat, gain, max(ref_px, 3.0), max(aspect, 0.05))
    particles = []
    for tr in tracks:
        if len(tr) < 2:
            continue
        ts, us, vs, ws, hs, bs = [], [], [], [], [], []
        sx_seq = envelope([q[4] for q in tr], 6, "peak" if flicker else "mean")
        sy_seq = envelope([q[5] for q in tr], 6, "peak" if flicker else "mean")
        br_seq = envelope([q[6] for q in tr], 6)
        for i, (t, X, Y, Z, sx, sy, br) in enumerate(tr[::2]):
            j = i * 2
            Zw = S.JZ + Z
            if S.H * S.S - Y * S.S + Zw * S.C < 2.0:
                continue
            p = stage_of(X, Y, Zw)
            u, v, du, dv = inverse_bilinear(p, c)
            ppy = (stage_of(X, Y + 0.01, Zw) - p)[1] / 0.01
            ppx = (stage_of(X + 0.01, Y, Zw) - p)[0] / 0.01
            hy = sy_seq[j] * abs(ppy); wx = sx_seq[j] * abs(ppx)
            if max_px:
                cap = max_px * abs(stage_of(0, 0, S.JZ)[1] - stage_of(0, 1, S.JZ)[1]) / abs(S.stage_px(0, 0, S.JZ)[1] - S.stage_px(0, 1, S.JZ)[1])
                hy, wx = min(hy, cap), min(wx, cap)
            ts.append(t + offset); us.append(u); vs.append(v)
            ws.append(wx / 2 / du * gx); hs.append(hy / 2 / dv * gy); bs.append(br_seq[j])
        if len(ts) < 2 or max(bs) <= 1e-3:
            continue
        # Breakpoints shared by every property: one particle per segment.
        # One breakpoint at most (from the property that needs it most), so a particle is at most two definitions.
        cand = [s for prop in (vs, us, hs) for s in fit(prop, ts, 0.08)[:-1]]
        brk = [0, len(ts) - 1]
        if cand:
            brk = sorted({0, len(ts) - 1, int(round((cand[0][1] - ts[0]) / max(ts[-1] - ts[0], 1e-6) * (len(ts) - 1)))})
        for a, b in zip(brk, brk[1:]):
            if b <= a:
                continue
            seg = lambda vals: fit(vals[a:b + 1], ts[a:b + 1], 0.5)[0]
            def P(vals):
                s0, s1, v0, v1, e = seg(vals)
                return {"from": {"c": round(vals[a], 5)}, "to": {"c": round(vals[b], 5)}, "ease": e if e in EASES else "linear"}
            al = [x / max(bs) for x in bs]
            particles.append(S.particle(sid, ts[a] / duration, (ts[b] - ts[a]) / duration, P(us), P(vs), P(ws), P(hs), P(al)))
    return particles, 0


def native_dots(pf, path, ps):
    """Ground-ellipse bursts with no node rotation and no animated velocity: drawn with native random draws."""
    sh = ps["ShapeModule"]
    vel = ps.get("VelocityModule", {})
    still = not vel.get("enabled") or all(abs(vel[a].get("scalar", 0)) < 1e-6 and abs(vel[a].get("minScalar", 0)) < 1e-6 for a in "xyz")
    return sh.get("enabled") and sh["type"] == 10 and np.allclose(pf.rotation(path), np.eye(3)) and still


def emitter_parts(pk, prefab, clip, W, loop=False):
    """Deterministic emitters of a prefab at width W: [(name, transform, groups)], last particle end."""
    pf = Prefab(prefab, clip, ROOT)
    out, end = [], 0.0
    for path, node in pf.nodes.items():
        if path in ("^", "") or not spec.comp(node, "ParticleSystem"):
            continue
        ps = spec.comp(node, "ParticleSystem")[0]
        if not ps["EmissionModule"].get("enabled") or spec.comp(node, "ParticleSystemRenderer")[0]["m_RenderMode"] == 4:
            continue
        if native_dots(pf, path, ps) and not loop:
            continue  # handled by simple.build_dots with native randomness
        if loop:
            parts, _ = simulate(pf, path, W, 2.0, dt=1 / 120)
            keep = []
            for i, p in enumerate(sorted(parts, key=lambda p: p["birth"])):
                if 1.2 <= p["birth"] < 1.2 + LOOP_PERIOD and (i * LOOP_KEEP) % 1 < LOOP_KEEP:
                    keep.append([(t - 1.2,) + q[1:] for (t, *_), q in zip(p["track"], p["track"])])
            tracks = []
            for tr in keep:  # wrap the tail past the period to the start
                a = [q for q in tr if q[0] < LOOP_PERIOD]; b = [(q[0] - LOOP_PERIOD,) + q[1:] for q in tr if q[0] >= LOOP_PERIOD]
                tracks += [x for x in (a, b) if len(x) >= 2]
        else:
            parts, _ = simulate(pf, path, W, 1.2)
            tracks = [p["track"] for p in parts if len(p["track"]) >= 2]
        if not tracks:
            continue
        mat = material_of(prefab, path)
        rgba = ps["InitialModule"]["startColor"]["maxColor"]
        t_on = min(tr[0][0] for tr in tracks)
        rgba = [pf.curve(path, f"InitialModule.startColor.maxColor.{ch}", rgba[ch], max(t_on, 0)) for ch in "rgba"]
        gain = S.hdr(rgba, TINTS[mat])
        size_curve = ps.get("SizeModule", {}).get("curve", {})
        flicker = len(size_curve.get("maxCurve", {}).get("m_Curve", [])) > 8
        corners = quad_for(tracks, W)
        duration = LOOP_PERIOD if loop else max(pf.stop, max(tr[-1][0] for tr in tracks))
        end = max(end, duration)
        out.append((path, corners, tracks, mat, gain, flicker, spec.comp(node, "ParticleSystemRenderer")[0]["m_MaxParticleSize"]))
    return out, end, pf


def T_native(prefab, clip, path, ps):
    return native_dots(Prefab(prefab, clip, ROOT), path, ps)


def build(out_dir, engine_dir):
    global PEAK_SHARE
    pk = S.Pack()
    rng = np.random.default_rng(7)
    table = {}
    variants = [(k, j, prefab, clip) for k, (prefab, clips) in enumerate(KINDS) for j, clip in clips.items()]
    variants.append(("loop", 0, LOOP[0], LOOP[1]))
    for kind, j, prefab, clip in variants:
        first, count, duration = len(pk.effects), None, 0.0
        loop = kind == "loop"
        e = S.extract_simple(clip) if False else None
        import spec
        spec.ROOT = ROOT
        from parts import extract
        ex = extract(prefab, clip, loop=loop)
        for bi, W in enumerate(S.BUCKETS):
            rows = []
            ems, end, pf = emitter_parts(pk, prefab, clip, W, loop)
            dur = max(ex["stop"], end) if not loop else LOOP_PERIOD
            for part in ex["parts"]:
                if part["kind"] == "frame":
                    if loop:  # the clip pulses the outline .6 -> .4 -> .6 at 10 Hz: a steady .5
                        part = dict(part, alpha=[0.5] * len(part["alpha"]))
                    frames = S.build_frame(pk, j, part, dur, bi, W)
                    if loop:
                        for _, _, groups in frames:
                            for g in groups:
                                g["particles"] = [dict(g["particles"][0], start=0, duration=1, a=S.prop(1))]
                    rows += frames
                elif part["kind"] == "wall":
                    walls = S.build_wall(pk, j, part, dur)
                    if loop:  # re-triggered every .15 s with a .2 s life: its mean level, held
                        for _, _, groups in walls:
                            for g in groups:
                                g["particles"] = [dict(g["particles"][0], start=0, duration=1, a=S.prop(0.6))]
                    rows += walls
                elif part["kind"] == "emitter" and not loop:
                    ps = part["ps"]
                    if T_native(prefab, clip, part["path"], ps):
                        rows += S.build_dots(pk, j, part, dur, bi, W, part["path"].split("/")[-1], rng)
            for path, corners, tracks, mat, gain, flicker, maxp in ems:
                PEAK_SHARE = 0.6 if mat == "note_point_simple" else 1.0
                ps_, peak = tracks_to_particles(pk, tracks, mat, gain, flicker, corners, dur, max_px=maxp * 1080)
                if ps_:
                    rows.append((f"Emit {path.split('/')[-1].strip()}", S.transform(corners), [{"count": 1, "particles": ps_}]))
            if count is None:
                count = len(rows)
            # Widths that drop an empty part keep the block shape with a blank effect.
            while len(rows) < count:
                rows.append(("Blank", S.transform([((0, 0), 0, S.JZ)] * 4), []))
            rows = rows[:count]
            for name, tf, groups in rows:
                pk.effect(f"Our Notes FX S{kind} {j} B{bi} {name}", tf, groups)
            duration = max(duration, dur)
        table[(kind, j)] = (first, count, duration)
        n = sum(g["count"] * len(g["particles"]) for ef in pk.effects[first + 3 * count: first + 4 * count] for g in ef["groups"])
        print(f"{prefab} {clip}: {count} parts, {n} particle defs at 2 lanes, {duration:.3f} s", flush=True)
    return pk, table


if __name__ == "__main__":
    out_dir, engine_dir = sys.argv[1], sys.argv[2]
    pk, table = build(out_dir, engine_dir)
    OLD = "/home/xuc/Documents/our-notes/packages/sonolus/dist/our-notes"
    old = json.loads(gzip.decompress(open(f"{OLD}/particle.data", "rb").read()))
    old_atlas = np.asarray(Image.open(f"{OLD}/particle.texture.png").convert("RGBA"))
    lane = [e for e in old["effects"] if e["name"].startswith("Our Notes Lane ")]
    remap = {}
    for e in lane:
        for g in e["groups"]:
            for p in g["particles"]:
                if p["sprite"] not in remap:
                    s = old["sprites"][p["sprite"]]
                    remap[p["sprite"]] = pk.tile(old_atlas[s["y"]:s["y"] + s["h"], s["x"]:s["x"] + s["w"]])
                p["sprite"] = remap[p["sprite"]]
    from build import pack
    atlas, rects = pack(pk.tiles)
    os.makedirs(out_dir, exist_ok=True)
    Image.fromarray(atlas).save(f"{out_dir}/particle.texture.png", optimize=True)
    data = {"width": atlas.shape[1], "height": atlas.shape[0], "interpolation": True,
            "sprites": [{"x": r[0], "y": r[1], "w": r[2], "h": r[3]} for r in rects], "effects": pk.effects + lane}
    open(f"{out_dir}/particle.data", "wb").write(gzip.compress(json.dumps(data, separators=(",", ":")).encode(), 9))
    import shutil
    shutil.copy(f"{OLD}/particle.thumbnail.png", f"{out_dir}/particle.thumbnail.png")
    json.dump({f"{k}|{j}": v for (k, j), v in table.items()}, open(f"{out_dir}/simple.table.json", "w"))
    num = lambda x: repr(round(float(x), 6))
    HEADER = "// Generated by the effect001Simple builder from the game's prefabs. Do not edit.\n"
    ts = [HEADER, "export const nativeHitFxNames = {"] + [f"    fx{i}: {json.dumps(e['name'])}," for i, e in enumerate(pk.effects)] + ["} as const", ""]
    ts.append(f"/** Note width buckets (world units): half-lane steps from {S.BUCKET_LANES[0]} to {S.BUCKET_LANES[-1]} lanes. */")
    ts.append(f"export const hitFxBucket = (w: number) => Math.min({len(S.BUCKETS) - 1}, Math.max(0, Math.floor(w / {num(S.LANE / 2)} - 0.5)))")
    ts.append("")
    ts.append("/** Kinds: 0 normal, 1 just, 2 slide, 3 connect, 4 flick, 5 flick left, 6 flick right. Judgement: native 2..6. */")
    for fn, idx in (("hitFxFirst", 0), ("hitFxCount", 1), ("hitFxDuration", 2)):
        ts.append(f"export const {fn} = (kind: number, judgment: number) => {{")
        for k in range(len(KINDS)):
            ts.append(f"    if (kind === {k}) {{")
            ts.append(f"        if (judgment >= 5) return {num(table[(k, 5)][idx])}")
            for j in (4, 3, 2):
                ts.append(f"        if (judgment === {j}) return {num(table[(k, j)][idx])}")
            ts.append("    }")
        ts.append(f"    return {'-1' if idx == 0 else '0'}")
        ts.append("}")
        ts.append("")
    lf, lc, ld = table[("loop", 0)]
    ts += [f"export const LOOP_FX_FIRST = {lf}", f"export const LOOP_FX_COUNT = {lc}", f"export const LOOP_FX_DURATION = {num(ld)}", ""]
    open(os.path.join(engine_dir, "shared/src/engine/data/nativeHitFxNames.generated.ts"), "w").write("\n".join(ts))
    print(f"{len(pk.effects)} effects, {len(pk.tiles)} tiles, atlas {atlas.shape[1]}x{atlas.shape[0]}, data {os.path.getsize(f'{out_dir}/particle.data') // 1024} KiB, texture {os.path.getsize(f'{out_dir}/particle.texture.png') // 1024} KiB")
