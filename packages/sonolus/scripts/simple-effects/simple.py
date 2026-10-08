"""effect001Simple ("Simple" note effect) as native Sonolus particles.

Source: effect001simple/note_normal_simple (decrypted prefab + clips). Parts:
  frame  ground outline, ef_tap_line (2 px at 100 ppu) under ef_tap_strong_glow, size (W + .4, 1.75) x 1.02
  wall   ef_wall mesh, life .2 s, under ef_tap_wall
  dots   ef_particle_point / _center: solid discs (ef_circle_icon) under note_point_simple, emitted from an
         ellipse on the ground (circle shape r .716, scale (W + .08, 2.06 | .94)), radial start speed, limit/drag
The frame and dots are baked per note width (half-lane steps) so lines and dots keep their exact screen size.
Dots use the particle engine's own random draws: one group per emission wave, cos/sin(2 pi r1) is the direction,
r2 the start radius, r3 the size, r4 the depth drift; nothing is pre-sampled per dot."""
import gzip, json, math, os, sys
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
import cam
from parts import extract, FPS
from emit import mm_eval, grad_eval
from build import pack

PREFAB = "note_normal_simple"
SKIN = "effect001simple"
DUMP = f"/home/xuc/.claude/jobs/50d4d325/tmp/fxre/out/{SKIN}/{PREFAB}"
CLIPS = {5: "note_simple_perfect", 4: "note_simple_great", 3: "note_simple_good", 2: "note_simple_bad"}
LANE = cam.LANE_WIDTH / 12
BUCKET_LANES = [n / 2 for n in range(1, 25)]  # note widths in lanes
BUCKETS = [l * LANE for l in BUCKET_LANES]
DENSITY = 2.0  # tile px per 1080p screen px

TINT = {"strong": (4.237, 4.237, 4.237, 0.549), "wall": (1.059, 1.059, 1.059, 0.718), "point": (1.151, 1.151, 1.151, 1.0)}
# LiveGameVolume bloom (threshold 1.2, intensity 5, scatter .7) on a 1080p target, reduced to its visible terms.
BLOOM = [(2.0, 0.55), (6.0, 0.25), (16.0, 0.10)]
GLOW_GAIN = float(os.environ.get("FX_GLOW", "1.0"))
BG = np.array((0.16, 0.15, 0.26))


def lin(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def hdr(rgba, tint):
    """MobileAddHdrColor: vertex * tint * tint * 2 (rgb), alpha quantised; returns linear additive rgb."""
    v, t = np.array(rgba[:3]), np.array(tint[:3])
    a = round(min(1.0, rgba[3] * tint[3] ** 2 * 2) * 255) / 255
    return lin(v) * t * t * 2 * a


def encode(emission, pad):
    """Linear additive emission (HxWx3, at DENSITY) -> straight-alpha RGBA over BG, with bloom; trimmed."""
    e = np.pad(emission, ((pad, pad), (pad, pad), (0, 0)))
    over = np.clip(e - 1.0, 0, None)  # only HDR overflow blooms
    glow = np.zeros_like(e)
    for sigma, weight in BLOOM:
        s = sigma * DENSITY
        glow += weight * np.stack([gaussian_filter(over[..., c] + 0.15 * e[..., c], s, mode="constant") for c in range(3)], 2)
    final = e + GLOW_GAIN * glow
    target = srgb(lin(BG)[None, None] + final)
    a = np.max(np.clip((target - BG) / np.maximum(1 - BG, 1e-3), 0, 1), axis=2)
    rgb = np.where(a[..., None] > 1e-5, np.clip((target - BG * (1 - a[..., None])) / np.maximum(a[..., None], 1e-5), 0, 1), 0)
    img = np.concatenate([rgb, a[..., None]], 2)
    return (np.round(img * 255)).astype(np.uint8)


def stage_px(X, Y, Z):
    """1080p screen px of a world point (stage basis 16:9)."""
    return np.array(cam.screen(X, Y, Z, 1920, 1080))


# ---------- projection: each part is a world rectangle; its corners' stage coords are linear in X0 and W ----------
H, S, C, TAN, JZ = cam.H, cam.S, cam.C, cam.TAN, cam.JUDGE_Z
KX = 6 * (H * S + JZ * C) / (cam.LANE_WIDTH / 2)


def stage_y(Y, Z):
    return (((Y - H) * C + Z * S) / (H * S - Y * S + Z * C) / TAN - cam.HORIZON_Y) / (cam.JUDGE_NDC_Y - cam.HORIZON_Y)


def transform(corners):
    """corners: bl, tl, tr, br as ((xa, xb), Y, Z): world x = X0 + xa + xb W."""
    t = {}
    for i, ((xa, xb), Y, Z) in enumerate(corners, 1):
        k = KX / (H * S - Y * S + Z * C)
        t[f"x{i}"] = {"x1": round(k, 7), "y1": round(xb * k, 7), "c": round(xa * k, 7)}
        t[f"y{i}"] = {"c": round(stage_y(Y, Z), 7)}
    return t


def ground_rect(xa0, xb0, xa1, xb1, z0, z1, Y=0.0):
    return transform([((xa0, xb0), Y, JZ + z0), ((xa0, xb0), Y, JZ + z1), ((xa1, xb1), Y, JZ + z1), ((xa1, xb1), Y, JZ + z0)])


def vertical_rect(xa0, xb0, xa1, xb1, y0, y1, z):
    return transform([((xa0, xb0), y0, JZ + z), ((xa0, xb0), y1, JZ + z), ((xa1, xb1), y1, JZ + z), ((xa1, xb1), y0, JZ + z)])


def prop(f, t=None, ease="linear"):
    t = f if t is None else t
    wrap = lambda v: v if isinstance(v, dict) else {"c": round(float(v), 5)}
    return {"from": wrap(f), "to": wrap(t), "ease": ease}


def particle(sprite, start, dur, x, y, w, h, a):
    return {"sprite": sprite, "color": "#ffffff", "start": round(start, 4), "duration": round(max(dur, 1e-3), 4),
            "x": x, "y": y, "w": w, "h": h, "r": prop(0), "a": a}


class Pack:
    def __init__(self):
        self.tiles, self.effects, self.keys = [], [], {}

    def tile(self, img, key=None):
        if key is not None and key in self.keys:
            return self.keys[key]
        self.tiles.append(img)
        if key is not None:
            self.keys[key] = len(self.tiles) - 1
        return len(self.tiles) - 1

    def effect(self, name, transform, groups):
        self.effects.append({"name": name, "transform": transform, "groups": groups})


def alpha_segments(values, stop, tol=0.03):
    """Sampled alpha (per frame) -> [(t0, t1, a0, a1, ease)] in normalised effect time."""
    from compose import fit_segments
    return [s for s in fit_segments(values, [i / FPS for i in range(len(values))], stop, tol) if s[2] > 1e-3 or s[3] > 1e-3]


# ---------- frame ----------
LINE = 0.02  # world thickness (2 px at 100 ppu)


CAP = 0.35  # world x the corner caps reach inward from a side line


def screen_rows(z_lo, z_hi, Y=0.0):
    """Tile rows for a ground band: screen y (1080p px, at DENSITY) from the far edge to the near edge, and the world
    z (rel. judgement line) of each row; quad-space y is linear in screen y, so rows are uniform in screen y."""
    y_far, y_near = stage_px(0, Y, JZ + z_hi)[1], stage_px(0, Y, JZ + z_lo)[1]
    n = max(4, int(round((y_near - y_far) * DENSITY)))
    ys = y_far + (np.arange(n) + 0.5) / n * (y_near - y_far)
    zs = np.interp(ys, [stage_px(0, Y, JZ + z)[1] for z in np.linspace(z_hi, z_lo, 400)], np.linspace(z_hi, z_lo, 400))
    return n, zs


def line_profile(n, zs, centres, thick):
    """Anti-aliased ground lines at world z centres, box-filtered over each tile row's world extent."""
    dz = np.abs(np.gradient(zs))
    out = np.zeros(n)
    for c in centres:
        lo, hi = c - thick / 2, c + thick / 2
        cover = np.clip(np.minimum(zs + dz / 2, hi) - np.maximum(zs - dz / 2, lo), 0, None) / np.maximum(dz, 1e-9)
        out = np.maximum(out, np.clip(cover, 0, 1))
    return out


def build_frame(pk, j, part, stop, b_index, W):
    alpha = part["alpha"]; rgb = part["rgb"]
    k = int(np.argmax(alpha))
    if alpha[k] <= 0:
        return []
    gain = hdr(list(rgb[k]) + [alpha[k]], TINT["strong"])
    gk = tuple(np.round(gain, 3))
    hz = 0.625
    halo_px = 3 * BLOOM[-1][0]
    # Halo in world units at the judgement line (screen-isotropic).
    halo_z = halo_px / ((stage_px(0, 0, JZ - 0.01)[1] - stage_px(0, 0, JZ)[1]) / 0.01)
    halo_x = halo_px / ((stage_px(0.01, 0, JZ)[0] - stage_px(0, 0, JZ)[0]) / 0.01)
    z_lo, z_hi = -hz - LINE / 2 - halo_z, hz + LINE / 2 + halo_z
    n, zs = screen_rows(z_lo, z_hi)
    rows = line_profile(n, zs, (-hz, hz), LINE)
    segs = alpha_segments([a / alpha[k] for a in alpha], stop)
    ap = lambda: [prop(a0, a1, e) for t0, t1, a0, a1, e in segs]

    def strip():
        wide = 96
        img = rows[:, None, None] * np.ones((1, wide, 1)) * gain[None, None]
        enc = encode(img, 0)
        return enc[:, wide // 2 - 2: wide // 2 + 2]
    sid = pk.tile(strip(), ("strip", gk, n))
    out = [("Frame", ground_rect(0.056 + CAP, -0.51, -0.056 - CAP, 0.51, z_lo, z_hi),
            [{"count": 1, "particles": [particle(sid, t0, t1 - t0, prop(0), prop(0), prop(1), prop(1), a) for (t0, t1, _, _, _), a in zip(segs, ap())]}])]

    # Caps: the side line, the corners and CAP of each long line, baked wider and cropped so the seam is uniform.
    px_x = (stage_px(0.01, 0, JZ)[0] - stage_px(0, 0, JZ)[0]) / 0.01 * DENSITY
    x_lo, x_hi = -CAP, LINE * 1.02 / 2 + halo_x  # world x relative to the side line centre (outward +)
    extra = halo_x * 2
    m = max(4, int(round((x_hi - x_lo + extra) * px_x)))
    xs = x_lo - extra + (np.arange(m) + 0.5) / px_x
    side = np.clip(np.minimum(xs + 0.5 / px_x, LINE * 1.02 / 2) - np.maximum(xs - 0.5 / px_x, -LINE * 1.02 / 2), 0, None) * px_x
    inside = (zs >= -hz - LINE / 2) & (zs <= hz + LINE / 2)
    long_part = rows[:, None] * (xs[None] <= 0).astype(float)
    mask = np.maximum(long_part, np.clip(side, 0, 1)[None] * inside[:, None])
    enc = encode(mask[..., None] * gain[None, None], 0)
    crop = int(round(extra * px_x))
    right = enc[:, crop:]
    sid_r = pk.tile(right, ("cap", gk, n, m))
    sid_l = pk.tile(right[:, ::-1].copy(), ("capL", gk, n, m))
    for name, sid_c, (xa0, xb0, xa1, xb1) in (
        ("Frame Right", sid_r, (-0.056 + x_lo, 0.51, -0.056 + x_hi, 0.51)),
        ("Frame Left", sid_l, (0.056 - x_hi, -0.51, 0.056 - x_lo, -0.51)),
    ):
        out.append((name, ground_rect(xa0, xb0, xa1, xb1, z_lo, z_hi),
                    [{"count": 1, "particles": [particle(sid_c, t0, t1 - t0, prop(0), prop(0), prop(1), prop(1), a) for (t0, t1, _, _, _), a in zip(segs, ap())]}]))
    return out


# ---------- wall ----------
def build_wall(pk, j, part, stop):
    """ef_wall front face only (the side faces are 1/30 of the box and invisible at .2 s). Uniform across x, so
    one tile stretches with the note width; the front sits at z +.64, the texture ridge (mesh y .534) on the ground."""
    ps = part["ps"]; ini = ps["InitialModule"]; size = ps["SizeModule"]
    sy = ini["startSizeY"]["scalar"] * size["y"]["scalar"] * size["y"]["maxCurve"]["m_Curve"][0]["value"]
    sz = ini["startSizeZ"]["scalar"] * size["z"]["scalar"] * size["z"]["maxCurve"]["m_Curve"][0]["value"]
    sx = ini["startSize"]["scalar"] * size["curve"]["scalar"] * size["curve"]["maxCurve"]["m_Curve"][0]["value"]
    z_front = part["pos"]["z"] + 0.5 * sz
    y0, y1 = -0.534 * sy, (2.40850282 - 0.534) * sy
    on = part["window"][0]
    rgba = part["start_rgba"][min(int(round(on * FPS)), len(part["start_rgba"]) - 1)]
    # Calibrated against the captured game frames (the wall-only light, scaled by Simple's wall alpha .51 / .85).
    gain = hdr(rgba, TINT["wall"]) * 0.7
    tex = np.asarray(Image.open(f"{DUMP}/TEX_ef_wall.png").convert("RGBA")).astype(float) / 255
    # Front u .2743-.7257 of the texture, v .0039-1; one column is enough (uniform in u).
    v_px = int(round((stage_px(0, 0, JZ + z_front)[1] - stage_px(0, y1, JZ + z_front)[1]) * DENSITY))
    col = tex[:, 128]
    vs = np.linspace(1.0, 0.0039, v_px)  # tile row 0 = top = v 1
    rows = np.interp((1 - vs) * 255, np.arange(256), col[:, 3] * col[:, :3].mean(1))
    cols_u = np.linspace(0.224267989, 0.770728827, 64) * 255
    face = np.stack([np.interp((1 - vs) * 255, np.arange(256), tex[:, int(round(c)), 3] * tex[:, int(round(c)), :3].mean(1)) for c in cols_u], 1)
    img = face[..., None] * gain[None, None]
    sid = pk.tile(encode(img, 0), ("wall", tuple(np.round(gain, 3)), v_px))
    life = ini["startLifetime"]["scalar"]
    col_mod = ps["ColorModule"]["gradient"]
    n = max(2, int(round(life * FPS)) + 1)
    env = [float(np.mean(grad_eval(col_mod, i / (n - 1))[0])) for i in range(n)]
    from compose import fit_segments
    segs = fit_segments(env, list(range(n)), n - 1, tol=0.03)
    parts = [particle(sid, (on + u0 * life) / stop, (u1 - u0) * life / stop, prop(0), prop(0), prop(1), prop(1), prop(a0, a1, e))
             for u0, u1, a0, a1, e in segs if a0 > 1e-3 or a1 > 1e-3]
    # The front plus its two bevels (u .224-.771) reaches the side faces at x = +-sx (W - .15); the bevels' slight
    # depth (.033) is invisible, so the whole front is one plane and no seam shows.
    hw = sx  # times (W - .15)
    out = [("Wall", vertical_rect(0.15 * hw, -hw, -0.15 * hw, hw, y0, y1, z_front), [{"count": 1, "particles": parts}])]
    # Side faces: x = +-sx (W - .15), receding from the front by sz; texture u 0-.224 (left) / .771-1 (right).
    for side, sgn, (ua, ub) in (("Left", -1, (0.0, 0.224267989)), ("Right", 1, (0.770728827, 1.0))):
        cols = np.linspace(ua, ub, 16) * 255
        face = np.stack([np.interp((1 - vs) * 255, np.arange(256), tex[:, int(round(c)), 3] * tex[:, int(round(c)), :3].mean(1)) for c in cols], 1)
        if sgn < 0:
            face = face[:, ::-1]  # u runs from the front edge outward
        sid_s = pk.tile(encode(face[..., None] * gain[None, None], 0), ("wallside", side, tuple(np.round(gain, 3)), v_px))
        xa, xb = -0.15 * sx * sgn, sx * sgn
        tf = transform([((xa, xb), y0, JZ + z_front), ((xa, xb), y1, JZ + z_front), ((xa, xb), y1, JZ + z_front - sz), ((xa, xb), y0, JZ + z_front - sz)])
        out.append((f"Wall {side}", tf, [{"count": 1, "particles": [dict(p, sprite=sid_s) for p in parts]}]))
    return out


# ---------- dots ----------
def dot_tile(rgb_gain, diameter_px):
    """Solid disc of the given screen diameter with its glow."""
    d = max(2.0, diameter_px * DENSITY)
    n = int(math.ceil(d)) + 2
    yy, xx = np.mgrid[0:n, 0:n] + 0.5
    r = np.hypot(xx - n / 2, yy - n / 2)
    disc = np.clip(d / 2 + 0.5 - r, 0, 1)
    pad = int(round(2.5 * BLOOM[1][0] * DENSITY))
    return encode(disc[..., None] * rgb_gain[None, None], pad), pad, n


def simulate_dots(ps, part, W, rng, samples=4000):
    """Unity-equivalent sampling of one ground-ellipse emitter: births, start radius/angle, speed, size; returns
    per-particle (birth, life_real, angle, rho, speed, size, vz) with sim-time integration of the limited speed."""
    ini, em, sh = ps["InitialModule"], ps["EmissionModule"], ps["ShapeModule"]
    L = ps["lengthInSec"]
    spd = part["simspeed"]
    t_on, t_off = part["window"]
    # Birth times: integrate rate over sim time (sim speed animated by the clip).
    births, acc, t, sim_t = [], 0.0, t_on, 0.0
    dt = 1 / 600
    while t < t_off and sim_t < L:
        s = spd[min(int(t * FPS), len(spd) - 1)]
        acc += mm_eval(em["rateOverTime"], sim_t / L, 0.5) * s * dt
        while acc >= 1:
            acc -= 1
            births.append((t, sim_t))
        sim_t += s * dt; t += dt
    out = []
    for (tb, simb) in births:
        life = mm_eval(ini["startLifetime"], 0, rng.random())
        v0 = mm_eval(ini["startSpeed"], 0, rng.random())
        size = mm_eval(ini["startSize"], 0, rng.random())
        vz = mm_eval(ps["VelocityModule"]["z"], 0, rng.random()) if ps["VelocityModule"].get("enabled") else 0.0
        out.append((tb, life, v0, size, vz))
    return out


def build_dots(pk, j, part, stop, b_index, W, name, rng):
    ps = part["ps"]; sh = ps["ShapeModule"]; ini = ps["InitialModule"]; clamp = ps["ClampVelocityModule"]
    k = int(round(part["window"][0] * FPS))
    rgba = part["start_rgba"][min(k, len(part["start_rgba"]) - 1)]
    gain = hdr(rgba, TINT["point"])
    R = sh["radius"]["value"]
    rx = R * (W + 0.08)
    rz = R * abs(sh["m_Scale"]["y"])
    Y = part["pos"]["y"]; zc = part["pos"]["z"]
    parts = simulate_dots(ps, part, W, rng)
    if not parts:
        return []
    spd = part["simspeed"]
    # Kinematics in sim time (same for every particle up to its start speed): speed limit 5 (1 - u), dampen .89
    # per 1/30 sim s above the limit, drag .74 per sim s; position integrated over real time.
    def travel(v0, life, tb):
        x, v, u, t = 0.0, v0, 0.0, tb
        trace = []
        dt = 1 / 240
        while u < 1:
            s = spd[min(int(t * FPS), len(spd) - 1)]
            lim = mm_eval(clamp["magnitude"], u, 0.5)
            if v > lim:
                v = lim + (v - lim) * (1 - clamp["dampen"]) ** (s * dt * 30)
            v *= max(0.0, 1 - mm_eval(clamp["drag"], u, 0.5) * s * dt)
            trace.append((t, x, u))
            x += v * s * dt; u += s * dt / life; t += dt
        trace.append((t, x, 1.0))
        return trace
    size_curve = ps["SizeModule"]["curve"]
    col = ps["ColorModule"]["gradient"]
    # Apparent size/brightness: the curves flicker far above 60 Hz; their running envelopes are what is seen.
    us = np.linspace(0, 1, 201)
    size_env = np.array([mm_eval(size_curve, u, 0.5) for u in us])
    peak = np.maximum.accumulate(size_env[::-1])[::-1]  # next-peak envelope
    bright = np.array([np.mean(grad_eval(col, u)[0]) * grad_eval(col, u)[1] for u in us])
    bright = np.convolve(bright, np.ones(15) / 15, mode="same")
    # Waves: group births into short windows; each wave is one group whose instances draw their own direction,
    # start radius, size and drift.
    waves = {}
    for p in parts:
        waves.setdefault(int((p[0] - part["window"][0]) * 30), []).append(p)
    # Quad: ground rect (plane y = Y) covering every dot position of this bucket.
    max_travel = max(max(x for _, x, _ in travel(p[2], p[1], p[0])) for p in parts[:: max(1, len(parts) // 40)])
    vz_max = max(p[4] for p in parts)
    qx = rx + max_travel * 1.05 + 0.3
    qz0 = -(rz + max_travel) * 1.05 - 0.3
    qz1 = (rz + max_travel) * 1.05 + vz_max * 0.6 + 0.3
    zc_q = (qz0 + qz1) / 2; hz = (qz1 - qz0) / 2
    # Normalised quad coords of a ground point (X rel. root, Z rel. zc) and the screen scale of a billboard.
    nx = lambda X: X / qx
    nz = lambda Zr: (Zr + zc - (zc + zc_q)) / hz
    centre = (0.0, Y, JZ + zc + zc_q)
    px_per_world_y = (stage_px(0, Y, centre[2])[1] - stage_px(0, Y + 0.01, centre[2])[1]) / 0.01
    px_per_world_z = (stage_px(0, Y, centre[2] - 0.01)[1] - stage_px(0, Y, centre[2])[1]) / 0.01
    px_per_world_x = (stage_px(0.01, Y, centre[2])[0] - stage_px(0, Y, centre[2])[0]) / 0.01
    ref_size = float(np.median([p[3] for p in parts]))
    dot_px = ref_size * px_per_world_y * 0.6
    img, pad, n = dot_tile(gain, dot_px)
    sid = pk.tile(img, ("dot", tuple(np.round(gain, 3)), round(dot_px, 1)))
    grow = (n + 2 * pad) / n  # tile includes the glow pad
    groups = []
    for key in sorted(waves):
        wave = waves[key]
        tb = float(np.mean([p[0] for p in wave]))
        life = float(np.mean([p[1] for p in wave]))
        v0s = sorted(p[2] for p in wave)
        tr = travel(float(np.mean(v0s)), life, tb)
        t_end = tr[-1][0]
        # Start radius uniform in area (rho = sqrt(u)); the mean radius is the group constant, r2 spreads it.
        rho0 = 0.5
        d_end = tr[-1][1]
        # Displacement eases out (limited speed): fit the ease from the trace.
        from compose import fit_segments
        xs = [x for _, x, _ in tr]
        seg = fit_segments([x / max(d_end, 1e-6) for x in xs[::4]], list(range(len(xs[::4]))), len(xs[::4]) - 1, tol=0.06)[0][4]
        sizes = [p[3] for p in wave]
        s_lo, s_hi = min(sizes), max(sizes)
        vzs = [p[4] for p in wave]
        z_lo, z_hi = min(vzs), max(vzs)
        def pos(dist, drift):
            # x = cos(2 pi r1) (rx rho + dist), z = sin(2 pi r1) (rz rho + dist) + drift (r4)
            return ({"cosr1": round(nx(rx * rho0 + dist), 5), "r2": round(nx(rx * 0.35), 5), "c": round(-nx(rx * 0.175), 5)},
                    {"sinr1": round((rz * rho0 + dist) / hz, 5), "c": round(nz(drift[0]), 5), "r4": round((drift[1] - drift[0]) / hz, 5)})
        drift_end = (z_lo * life * 0.25, z_hi * life * 0.25)
        x0, z0 = pos(0.0, (0.0, 0.0)); x1, z1 = pos(d_end, drift_end)
        # Size: billboard diameter in quad units (x by quad half width, y by its projected half height).
        def wh(scale):
            w = {"c": round(scale * s_lo * px_per_world_x / (qx * px_per_world_x) * grow / 2 / (ref_size * 0.6 / ref_size), 5)}
            return w
        sw = lambda s: s * 0.6 * grow / 2 / qx * (px_per_world_y / px_per_world_x)
        sh_ = lambda s: s * 0.6 * grow / 2 * px_per_world_y / (hz * px_per_world_z)
        start = (tb) / stop
        dur = (t_end - tb) / stop
        # Two phases share the group's draws: bright until the flicker first dims (u .3), then fading out.
        fa = float(peak[0])
        xb, zb = pos(d_end, drift_end)
        w = {"from": {"c": round(sw(s_lo) * fa, 5), "r3": round(sw(s_hi - s_lo) * fa, 5)}, "to": {"c": 0}, "ease": "inQuad"}
        h = {"from": {"c": round(sh_(s_lo) * fa, 5), "r3": round(sh_(s_hi - s_lo) * fa, 5)}, "to": {"c": 0}, "ease": "inQuad"}
        pl = [particle(sid, start, dur, {"from": x0, "to": xb, "ease": seg}, {"from": z0, "to": zb, "ease": seg}, w, h, prop(1, 0, "inQuad"))]
        groups.append({"count": len(wave), "particles": pl})
    return [(f"Dots {name}", ground_rect(-qx, 0, qx, 0, zc + qz0, zc + qz1, Y), groups)]


def build(out_dir, engine_dir):
    pk = Pack()
    blocks = {}
    rng = np.random.default_rng(7)
    for j, clip in list(CLIPS.items()) + [(0, "note_simple_perfect")]:
        e = extract(PREFAB.replace("", ""), clip) if False else extract_simple(clip)
        first = len(pk.effects)
        count = None
        for bi, W in enumerate(BUCKETS):
            parts_out = []
            for part in e["parts"]:
                if part["kind"] == "frame":
                    if j == 0:  # hold loop: a steady outline
                        part = dict(part, alpha=[0.0] + [0.75] * (len(part["alpha"]) - 1))
                    parts_out += build_frame(pk, j, part, e["stop"], bi, W)
                elif part["kind"] == "wall" and j != 0:
                    parts_out += build_wall(pk, j, part, e["stop"])
                elif part["kind"] == "emitter":
                    parts_out += build_dots(pk, j, part, e["stop"], bi, W, part["path"].split("/")[-1], rng)
            if count is None:
                count = len(parts_out)
            assert len(parts_out) == count
            for name, tf, groups in parts_out:
                pk.effect(f"Our Notes FX Simple {j} B{bi} {name}", tf, groups)
        blocks[j] = (first, count, e["stop"])
        print(f"judgement {j}: {count} parts x {len(BUCKETS)} widths, {sum(g['count'] * len(g['particles']) for ef in pk.effects[first:first + count] for g in ef['groups'])} particles per hit (first bucket)", flush=True)
    return pk, blocks


def extract_simple(clip):
    import spec
    old = spec.ROOT
    spec.ROOT = f"/home/xuc/.claude/jobs/50d4d325/tmp/fxre/out/{SKIN}"
    try:
        return extract(PREFAB, clip)
    finally:
        spec.ROOT = old


if __name__ == "__main__":
    out_dir, engine_dir = sys.argv[1], sys.argv[2]
    pk, blocks = build(out_dir, engine_dir)
    # Lane lights from the shipped pack.
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
    atlas, rects = pack(pk.tiles)
    os.makedirs(out_dir, exist_ok=True)
    Image.fromarray(atlas).save(f"{out_dir}/particle.texture.png", optimize=True)
    data = {"width": atlas.shape[1], "height": atlas.shape[0], "interpolation": True,
            "sprites": [{"x": r[0], "y": r[1], "w": r[2], "h": r[3]} for r in rects], "effects": pk.effects + lane}
    open(f"{out_dir}/particle.data", "wb").write(gzip.compress(json.dumps(data, separators=(",", ":")).encode(), 9))
    import shutil
    shutil.copy(f"{OLD}/particle.thumbnail.png", f"{out_dir}/particle.thumbnail.png")
    json.dump({"blocks": {str(k): v for k, v in blocks.items()}}, open(f"{out_dir}/simple.table.json", "w"))
    # Engine table: every note kind uses Simple; native judgement 2..6 (6 Just plays Perfect).
    num = lambda x: repr(round(float(x), 6))
    HEADER = "// Generated by the effect001Simple builder from the game's prefab. Do not edit.\n"
    ts = [HEADER, "export const nativeHitFxNames = {"] + [f"    fx{i}: {json.dumps(e['name'])}," for i, e in enumerate(pk.effects)] + ["} as const", ""]
    th = [(a + b) / 2 for a, b in zip(BUCKETS, BUCKETS[1:])]
    ts.append(f"/** Note width buckets (world units): half-lane steps from {BUCKET_LANES[0]} to {BUCKET_LANES[-1]} lanes. */")
    ts.append(f"export const hitFxBucket = (w: number) => Math.min({len(BUCKETS) - 1}, Math.max(0, Math.floor(w / {num(LANE / 2)} - 0.5)))")
    ts.append("")
    for fn, idx in (("hitFxFirst", 0), ("hitFxCount", 1), ("hitFxDuration", 2)):
        ts.append(f"/** Simple effect block for a native judgement (every note kind shares it). */")
        ts.append(f"export const {fn} = (_kind: number, judgment: number) => {{")
        ts.append(f"    if (judgment >= 5) return {num(blocks[5][idx])}")
        for j in (4, 3, 2):
            ts.append(f"    if (judgment === {j}) return {num(blocks[j][idx])}")
        ts.append(f"    return {'-1' if idx == 0 else '0'}")
        ts.append("}")
        ts.append("")
    ts += [f"export const LOOP_FX_FIRST = {blocks[0][0]}", f"export const LOOP_FX_COUNT = {blocks[0][1]}", f"export const LOOP_FX_DURATION = {num(blocks[0][2])}", ""]
    open(os.path.join(engine_dir, "shared/src/engine/data/nativeHitFxNames.generated.ts"), "w").write("\n".join(ts))
    total = sum(len(p["particles"]) for e in pk.effects for p in e["groups"])
    print(f"{len(pk.effects)} effects, {len(pk.tiles)} tiles, atlas {atlas.shape[1]}x{atlas.shape[0]}, data {os.path.getsize(f'{out_dir}/particle.data') // 1024} KiB, texture {os.path.getsize(f'{out_dir}/particle.texture.png') // 1024} KiB")
