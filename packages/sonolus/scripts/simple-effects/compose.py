"""Compose Sonolus particle effects for the effect001 hit effects.

Every part is its own small effect, spawned by the engine on a quad it projects from the part's world rectangle
(LiveGameCamera). Rectangles are affine in the note width W (world units), so the engine evaluates them per note
and widths need no authored buckets except for emitters, whose sprite size must not scale with W."""
import json, math, os, random
import numpy as np
from PIL import Image
import cam
from bake import bake, hdr_gain, sample
from parts import extract, FPS
from emit import simulate, mm_eval, grad_eval

DUMP = "/home/xuc/.claude/jobs/50d4d325/tmp/fxre/out/effect001"
REF_W = 3.2  # two lanes, the commonest note width
EMITTER_BUCKETS = [2.4, 3.2, 4.8, 6.4, 9.6, 19.2]
TINT = {"ef_tap_normal_glow": (2.996, 2.996, 2.996, 0.616), "ef_tap_strong_glow": (4.237, 4.237, 4.237, 0.549), "ef_tap_wall": (1.059, 1.059, 1.059, 0.718)}
EASES = ["linear", "inQuad", "outQuad", "inOutQuad", "inCubic", "outCubic", "inOutCubic", "inSine", "outSine", "inOutSine", "inExpo", "outExpo"]


def ease_fn(name):
    f = {
        "linear": lambda p: p, "inQuad": lambda p: p * p, "outQuad": lambda p: 1 - (1 - p) ** 2,
        "inOutQuad": lambda p: 2 * p * p if p < .5 else 1 - (-2 * p + 2) ** 2 / 2,
        "inCubic": lambda p: p ** 3, "outCubic": lambda p: 1 - (1 - p) ** 3,
        "inOutCubic": lambda p: 4 * p ** 3 if p < .5 else 1 - (-2 * p + 2) ** 3 / 2,
        "inSine": lambda p: 1 - math.cos(p * math.pi / 2), "outSine": lambda p: math.sin(p * math.pi / 2),
        "inOutSine": lambda p: -(math.cos(math.pi * p) - 1) / 2,
        "inExpo": lambda p: 0 if p == 0 else 2 ** (10 * p - 10), "outExpo": lambda p: 1 if p == 1 else 1 - 2 ** (-10 * p),
    }
    return f[name]


def fit_segments(values, times, stop, tol=0.02):
    """Piecewise eased segments through sampled values; splits where an eased segment misses by > tol."""
    segs = []
    i = 0
    n = len(values)
    while i < n - 1:
        best = None
        for j in range(n - 1, i, -1):
            v0, v1 = values[i], values[j]
            for e in EASES:
                f = ease_fn(e)
                err = max(abs(v0 + (v1 - v0) * f((k - i) / (j - i)) - values[k]) for k in range(i, j + 1))
                if err <= tol and (best is None or err < best[2]):
                    best = (j, e, err)
            if best:
                break
        j, e, _ = best if best else (i + 1, "linear", 0)
        segs.append((times[i] / stop, times[j] / stop, values[i], values[j], e))
        i = j
    return segs


# ---------- projection densities (tile px per world unit, 1080p) ----------
def density(plane, x, y, z):
    eps = 1e-3
    p0 = np.array(cam.screen(x, y, z))
    if plane == "v":
        du = np.linalg.norm(np.array(cam.screen(x + eps, y, z)) - p0) / eps
        dv = np.linalg.norm(np.array(cam.screen(x, y + eps, z)) - p0) / eps
    elif plane == "g":
        du = np.linalg.norm(np.array(cam.screen(x + eps, y, z)) - p0) / eps
        dv = np.linalg.norm(np.array(cam.screen(x, y, z + eps)) - p0) / eps
    else:  # side plane x = const, u along z
        du = np.linalg.norm(np.array(cam.screen(x, y, z + eps)) - p0) / eps
        dv = np.linalg.norm(np.array(cam.screen(x, y + eps, z)) - p0) / eps
    return du, dv


class EmptyTile(Exception):
    pass


class Build:
    def __init__(self):
        self.tiles = []  # (key, rgba uint8)
        self.tile_index = {}
        self.effects = []  # sonolus effects
        self.table = {}  # engine geometry: effect name -> part entries

    def tile(self, key, make):
        if key not in self.tile_index:
            img, pads = make()
            if img is None:
                self.tile_index[key] = None
            else:
                self.tile_index[key] = (len(self.tiles), pads, img.shape[1], img.shape[0])
                self.tiles.append(img)
        if self.tile_index[key] is None:
            raise EmptyTile()
        return self.tile_index[key]


TEX = {}


def tex(name):
    if name not in TEX:
        path = {"ef_tap_line": "SPR_ef_tap_line.png", "ef_tap_pillar": "SPR_ef_tap_pillar.png", "ef_wall": "TEX_ef_wall.png", "ef_tap_particle_star": "TEX_ef_tap_particle_star.png"}[name]
        TEX[name] = np.asarray(Image.open(os.path.join(DUMP, "note_normal", path)).convert("RGBA")).astype(np.float64) / 255
    return TEX[name]


def emission_tile(texname, uv, size_px, gain):
    t = sample(tex(texname), uv, max(1, int(round(size_px[0]))), max(1, int(round(size_px[1]))))
    return t[..., :3] * t[..., 3:4] * np.asarray(gain)[None, None, :]


def particle(sprite, start, duration, x, y, w, h, a, r=None):
    def prop(v):
        if isinstance(v, dict):
            return v
        if isinstance(v, tuple):
            f, t, e = v
            return {"from": f if isinstance(f, dict) else {"c": round(f, 4)}, "to": t if isinstance(t, dict) else {"c": round(t, 4)}, "ease": e}
        return {"from": {"c": round(v, 4)}, "to": {"c": round(v, 4)}, "ease": "linear"}
    return {"sprite": sprite, "color": "#ffffff", "start": round(start, 4), "duration": round(max(1e-3, duration), 4),
            "x": prop(x), "y": prop(y), "w": prop(w), "h": prop(h), "r": {"from": {}, "to": {}}, "a": prop(a)}


# ---------- geometry helpers: world rect -> engine table entry ----------
def rect(plane, u, v, at=0.0):
    """u, v: ((a, b), (a, b)) affine in W for the low and high edge. `at`: the plane's fixed coordinate (z for
    'v', y=0 for 'g' with v = z, x for 's' given as (a, b))."""
    return {"plane": plane, "u": u, "v": v, "at": at}


def alpha_segments(alpha, stop, peak):
    vals = [a / peak if peak > 0 else 0 for a in alpha]
    times = [i / FPS for i in range(len(vals))]
    return fit_segments(vals, times, stop)


def add_effect(b, name, geometry, groups):
    b.effects.append({"name": name, "transform": {k: {k: 1} for k in ("x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4")}, "groups": groups})
    b.table[name] = geometry


def windowed_particles(sprite, segs, x, y, w, h, wseg=None):
    """One particle per alpha segment (skipping fully transparent ones)."""
    out = []
    for (t0, t1, a0, a1, e) in segs:
        if a0 <= 1e-3 and a1 <= 1e-3:
            continue
        ww = w
        if wseg is not None:
            ww = wseg(t0, t1)
        out.append(particle(sprite, t0, t1 - t0, x, y, ww, h, (a0, a1, e)))
    return out


def frame_parts(b, base, part, stop, judgement):
    """Ground outline: two long edges (one stretched tile) and two short edges (one tile, mirrored)."""
    rgb = np.array(part["rgb"]); alpha = part["alpha"]
    k = int(np.argmax(alpha)); peak = alpha[k]
    if peak <= 0:
        return
    gain = hdr_gain(list(rgb[k]) + [peak], TINT["ef_tap_strong_glow"])
    zl, th = 0.875 - 0.26, 0.02  # line centre inset 0.26 from the 1.75-deep sprite edge, 2 px thick
    du, dv = density("g", 0, 0, cam.JUDGE_Z)
    segs = alpha_segments(alpha, stop, peak)
    # Long edges: v covers both lines, u uniform (no horizontal pad).
    core_v = 2 * (zl + th / 2)
    nv = core_v * dv
    def make_long():
        img = np.zeros((int(round(nv)), 4, 3))
        line = max(1, int(round(th * dv)))
        img[:line] = gain; img[-line:] = gain
        return bake(img, (1, 1), pads=(False, False, True, True))
    sid, pads, tw, thh = b.tile(("frame-long", tuple(np.round(gain, 3)), round(nv)), make_long)
    _, _, pb, pt = pads
    h = (nv + pb + pt) / nv; y = (pt - pb) / nv
    xl = (0.51, -0.056 + th / 2)
    add_effect(b, f"{base} Frame Long", rect("g", ((-xl[1], -xl[0]), (xl[1], xl[0])), ((-core_v / 2, 0), (core_v / 2, 0))),
               [{"count": 1, "particles": windowed_particles(sid, segs, 0, y, 1, h)}])
    # Short edges: a vertical (in z) line with a full halo, on its own quad at each side.
    def make_short():
        nu = max(1, int(round(th * du)))
        img = np.zeros((int(round(nv)), nu, 3)); img[:] = gain
        return bake(img, (1, 1))
    sid2, pads2, tw2, th2 = b.tile(("frame-short", tuple(np.round(gain, 3)), round(nv)), make_short)
    pl, pr, pb, pt = pads2; nu = tw2 - pl - pr
    w = (nu + pl + pr) / nu; x = (pr - pl) / nu; h = (nv + pb + pt) / nv; y = (pt - pb) / nv
    for side, sgn in (("Left", -1), ("Right", 1)):
        c = (sgn * (xl[0]), sgn * (-0.056))  # line centre: sgn * (0.51 W - 0.056)
        add_effect(b, f"{base} Frame {side}", rect("g", ((c[1] - th / 2, c[0]), (c[1] + th / 2, c[0])), ((-core_v / 2, 0), (core_v / 2, 0))),
                   [{"count": 1, "particles": windowed_particles(sid2, segs, x, y, w, h)}])


def pillar_part(b, base, part, stop, judgement, index):
    rgb = np.array(part["rgb"]); alpha = part["alpha"]; size = part["size"]
    k = int(np.argmax(alpha)); peak = alpha[k]
    if peak <= 0:
        return
    gain = hdr_gain(list(rgb[k]) + [peak], TINT["ef_tap_normal_glow"])
    zp = part["pos"]["z"]; ypos = part["pos"]["y"]
    # The sprite rect is 128 px wide; its 24.9 px texture rect (the beam) sits centred in it.
    beam = 24.9141845703125 / 128
    wmax = max(s[0] for s in size) * beam; hh = size[k][1]
    du, dv = density("v", 0, 0, cam.JUDGE_Z + zp)
    bottom = ypos - 0.04267627373337746 * hh
    nu, nv = wmax * du, hh * dv
    uv = (0, 0, 1, 1)  # SPR_ef_tap_pillar.png is already the 25 x 128 sprite rect
    sid, pads, tw, th = b.tile(("pillar", tuple(np.round(gain, 3)), round(nu), round(nv)), lambda: bake(emission_tile("ef_tap_pillar", uv, (nu, nv), gain), (1, 1)))
    pl, pr, pb, pt = pads; nu_i = tw - pl - pr; nv_i = th - pb - pt
    wfull = (nu_i + pl + pr) / nu_i; x = (pr - pl) / nu_i; h = (nv_i + pb + pt) / nv_i; y = (pt - pb) / nv_i
    segs = alpha_segments(alpha, stop, peak)
    sx = [s[0] * beam / wmax for s in size]
    def wseg(t0, t1):
        i0, i1 = int(round(t0 * stop * FPS)), int(round(t1 * stop * FPS))
        return (wfull * sx[min(i0, len(sx) - 1)], wfull * sx[min(i1, len(sx) - 1)], "outQuad")
    side = -1 if part["pos"]["x"] < 0 else 1
    add_effect(b, f"{base} Pillar {index}", rect("v", ((-wmax / 2, side * 0.5), (wmax / 2, side * 0.5)), ((bottom, 0), (bottom + hh, 0)), at=zp),
               [{"count": 1, "particles": windowed_particles(sid, segs, x, y, wfull, h, wseg)}])


def wall_part(b, base, part, stop, loop):
    """The tap wall mesh: a front face (uniform across x, stretched with W) and two side faces, each on its own
    quad. Mesh vertex = (mesh - pivot) * size, so the box is centred on the judgement line (front at z +.64) and
    the texture ridge (mesh y .534) sits on the ground."""
    ps = part["ps"]; ini = ps["InitialModule"]; size = ps["SizeModule"]
    sx = ini["startSize"]["scalar"] * size["curve"]["scalar"] * size["curve"]["maxCurve"]["m_Curve"][0]["value"]
    sy = ini["startSizeY"]["scalar"] * size["y"]["scalar"] * size["y"]["maxCurve"]["m_Curve"][0]["value"]
    sz = ini["startSizeZ"]["scalar"] * size["z"]["scalar"] * size["z"]["maxCurve"]["m_Curve"][0]["value"]
    z0 = part["pos"]["z"]
    life = ini["startLifetime"]["scalar"]
    spd = part["simspeed"][0] if part["simspeed"] else 1.0
    life_real = life / max(spd, 1e-6)
    col = part["ps"]["ColorModule"]["gradient"]
    on, off = part["window"]
    k = int(round(on * FPS))
    rgba = part["start_rgba"][min(k, len(part["start_rgba"]) - 1)]
    gain = hdr_gain(rgba, TINT["ef_tap_wall"]) * CAL["wall"]
    y_lo, y_hi = (0 - 0.534) * sy, (2.40850282 - 0.534) * sy
    z_front = z0 + 0.5 * sz
    # Lifetime colour (black -> white -> black) is a brightness envelope: alpha segments over the particle life.
    n = max(2, int(round(life_real * FPS)) + 1)
    env = [np.mean(grad_eval(col, i / (n - 1))[0]) * grad_eval(col, i / (n - 1))[1] for i in range(n)]
    du, dv = density("v", 0, 0, cam.JUDGE_Z + z_front)
    nv = (y_hi - y_lo) * dv
    def emissions(times):
        return [t for t in times if on <= t < off]
    if loop:
        rate = ps["EmissionModule"]["rateOverTime"]["scalar"] * spd
        births = emissions([i / rate for i in range(int(stop * rate) + 1)])
    else:
        births = [on]
    def particles_for(sid, x, y, w, h, start_scale=1.0):
        out = []
        for t_b in births:
            times = [t_b + i / FPS for i in range(n)]
            segs = fit_segments(env, list(range(n)), n - 1, tol=0.03)
            for (u0, u1, a0, a1, e) in segs:
                t0 = t_b + u0 * (n - 1) / FPS; t1 = t_b + u1 * (n - 1) / FPS
                if t0 >= (off if not loop else stop): continue
                t1 = min(t1, off if not loop else stop + life_real)
                if a0 <= 1e-3 and a1 <= 1e-3: continue
                out.append(particle(sid, t0 / stop, (t1 - t0) / stop, x, y, w, h, (a0, a1, e)))
        return out
    # Front: u .2743-.7257 of ef_wall, uniform in u (no horizontal pad).
    uv_front = (0.2742908, 0.0039, 0.725790977, 1.0)
    sid, pads, tw, th = b.tile(("wall-front", tuple(np.round(gain, 3)), round(nv)), lambda: bake(emission_tile("ef_wall", uv_front, (8, nv), gain), (1, 1), pads=(False, False, True, True)))
    _, _, pb, pt = pads; nv_i = th - pb - pt
    h = (nv_i + pb + pt) / nv_i; y = (pt - pb) / nv_i
    hw = 0.966932595 * sx  # times (W - .15)
    add_effect(b, f"{base} Wall Front", rect("v", ((0.15 * hw, -hw), (-0.15 * hw, hw)), ((y_lo, 0), (y_hi, 0)), at=z_front),
               [{"count": 1, "particles": particles_for(sid, 0, y, 1, h)}])
    # Sides: x = +-sx (W - .15), z from front to front - sz; u .0-.2243 (left) / .7708-1 (right), no horizontal pad.
    for side, sgn, uv in (("Left", -1, (0.0, 0.0039, 0.224267989, 1.0)), ("Right", 1, (0.770728827, 0.0039, 1.0, 1.0))):
        sid2, pads2, tw2, th2 = b.tile(("wall-side", side, tuple(np.round(gain, 3)), round(nv)), lambda uv=uv: bake(emission_tile("ef_wall", uv, (8, nv), gain), (1, 1), pads=(False, False, True, True)))
        _, _, pb2, pt2 = pads2; nv2 = th2 - pb2 - pt2
        xs = (-0.15 * sx * sgn, sx * sgn)
        add_effect(b, f"{base} Wall {side}", {"plane": "s", "x": xs, "u": ((z_front - sz, 0), (z_front, 0)) if sgn < 0 else ((z_front, 0), (z_front - sz, 0)), "v": ((y_lo, 0), (y_hi, 0))},
                   [{"count": 1, "particles": particles_for(sid2, 0, (pt2 - pb2) / nv2, 1, (nv2 + pb2 + pt2) / nv2)}])


SHAPE_WIDTH_OFFSET = {"ef_particle_point": 0.08, "ef_particle_star": -0.02}
V_LO, V_HI = -1.2, 8.0
KEEP = {"ef_particle_point": 24, "ef_particle_star": 4}
# Brightness calibration against the captured game frames (frame-9.80 .. 9.93).
FLICKER = {"ef_particle_point"}
# Screen-sized sweeps clamped by m_MaxParticleSize in the game; not reproduced yet.
SKIP_EMITTERS = {"ef_particl_splash_line", "ef_particl_splash_line02"}
SIZE_CAL = {"ef_particle_star": 0.55}
CAL = {"wall": 0.55, "ef_particle_star": 0.45, "ef_particle_point": 2.4}


def emitter_part(b, base, part, stop, loop, bucket):
    ps = part["ps"]; name = part["path"].split("/")[-1]; ini = ps["InitialModule"]
    rend = part["renderer"]
    sh = ps["ShapeModule"]
    if name in SKIP_EMITTERS:
        return
    follows = name in SHAPE_WIDTH_OFFSET
    if not follows and bucket != EMITTER_BUCKETS[0]:
        return  # fixed-width emitters do not depend on the note width
    ws = bucket + SHAPE_WIDTH_OFFSET[name] if follows else max(0.05, sh["m_Scale"]["x"] * part["scale"]["x"]) if sh.get("enabled") else 0.05
    spd = part["simspeed"][int(round(part["window"][0] * FPS))] if part["simspeed"] else ps.get("simulationSpeed", 1)
    sim = simulate(ps, 1, ws, part["window"], seed=7, sim_speed=spd, loop=loop)
    if not sim:
        return
    k = int(round(part["window"][0] * FPS))
    rgba = part["start_rgba"][min(k, len(part["start_rgba"]) - 1)]
    mat = "ef_tap_normal_glow"
    keep = KEEP.get(name, min(len(sim), 6))
    picks = [sim[int((i + 0.5) * len(sim) / keep)] for i in range(min(keep, len(sim)))]
    flux = min(1.6, (len(sim) / len(picks)) ** 0.5)
    # Sizes that flicker faster than the screen read at about 0.6 of their running peak.
    def apparent(p, i):
        v = [s[i] for s in p["samples"]]
        flick = name in FLICKER
        return (0.6 * max(v) if flick else float(np.mean(v))) * SIZE_CAL.get(name, 1.0)
    sizes = [apparent(p, 4) for p in sim]; sizesy = [apparent(p, 5) for p in sim]
    ref_w, ref_h = float(np.median(sizes)), float(np.median(sizesy))
    # Vertical billboard: x size = startSize * size.x curve, y size = startSize(Y) * size.y curve.
    if ref_w <= 1e-4 or ref_h <= 1e-4:
        return
    bright = np.mean([np.mean([s[6] * s[7] for s in p["samples"]]) for p in sim])
    gain = hdr_gain(rgba, TINT[mat]) * flux * bright * CAL.get(name, 1.0)
    du, dv = density("v", 0, 0, cam.JUDGE_Z + part["pos"]["z"])
    nu, nv = ref_w * du, ref_h * dv
    sid, pads, tw, th = b.tile(("spark", name, tuple(np.round(gain, 3)), round(nu), round(nv)),
                               lambda: bake(emission_tile("ef_tap_particle_star", (0, 0, 1, 1), (max(2, nu), max(2, nv)), gain), (1, 1)))
    pl, pr, pb, pt = pads; nu_i = tw - pl - pr; nv_i = th - pb - pt
    fx = (nu_i + pl + pr) / nu_i; fy = (nv_i + pb + pt) / nv_i
    vmid, vhalf = (V_LO + V_HI) / 2, (V_HI - V_LO) / 2
    y_off = part["pos"]["y"]
    groups = []
    for p in picks:
        parts_out = []
        smp = p["samples"]
        t0, t1 = p["birth"], p["death"]
        if t1 - t0 < 1 / FPS:
            continue
        ys = [s[2] + y_off for s in smp]
        segs_y = fit_segments(ys, list(range(len(ys))), len(ys) - 1, tol=0.08)
        (u0, u1, y0, y1, ey) = (0, 1, ys[0], ys[-1], segs_y[0][4] if len(segs_y) == 1 else "outQuad")
        # The size/colour flicker runs far above 60 Hz on screen; keep its envelope (a running mean).
        raw = [s[6] * s[7] / max(1e-6, bright) for s in smp]
        k = 6
        a = [min(1.0, sum(raw[max(0, i - k):i + k + 1]) / len(raw[max(0, i - k):i + k + 1])) for i in range(len(raw))]
        segs_a = fit_segments(a, list(range(len(a))), len(a) - 1, tol=0.25)
        if len(segs_a) > 2:
            mid = len(a) // 2
            segs_a = [(0, mid / (len(a) - 1), a[0], a[mid], "outQuad"), (mid / (len(a) - 1), 1, a[mid], a[-1], "inQuad")]
        scale_w = apparent(p, 4) / ref_w; scale_h = apparent(p, 5) / ref_h
        w = scale_w * (ref_w / 2) / (ws / 2) * fx
        h = scale_h * (ref_h / 2) / vhalf * fy
        yc0 = (y0 + ref_h * scale_h / 2 - vmid) / vhalf; yc1 = (y1 + ref_h * scale_h / 2 - vmid) / vhalf
        xexpr = {"c": -1.0, "r1": 2.0} if follows else {"c": 0.0}
        for (a0f, a1f, a0, a1, ea) in segs_a:
            s0 = t0 + a0f * (t1 - t0); s1 = t0 + a1f * (t1 - t0)
            if a0 <= 1e-3 and a1 <= 1e-3:
                continue
            # y position at the segment ends along the fitted rise.
            from compose import ease_fn as _e
            f = _e(ey)
            yy0 = yc0 + (yc1 - yc0) * f(a0f); yy1 = yc0 + (yc1 - yc0) * f(a1f)
            parts_out.append(particle(sid, s0 / stop, (s1 - s0) / stop, (xexpr, xexpr, "linear"), (yy0, yy1, "linear" if len(segs_a) > 1 else ey), w, h, (a0, a1, ea)))
        # Each spark is its own group: particles of one group share their random draws (r1 = x position).
        if parts_out:
            groups.append({"count": 1, "particles": parts_out})
    if not groups:
        return
    entry = rect("v", ((-ws / 2, 0), (ws / 2, 0)) if not follows else ((-SHAPE_WIDTH_OFFSET[name] / 2, -0.5), (SHAPE_WIDTH_OFFSET[name] / 2, 0.5)), ((V_LO, 0), (V_HI, 0)), at=part["pos"]["z"])
    entry["bucket"] = follows
    add_effect(b, f"{base} {name} W{bucket:g}" if follows else f"{base} {name}", entry, groups)
