"""Render a served pack exactly as Sonolus evaluates it: effect transform (inputs x1 = note centre, y1 = width),
per-instance random draws r1..r8 with sin/cos(2 pi r), bilinear placement in the quad, straight-alpha over."""
import gzip, json, math, os
import numpy as np
from PIL import Image
import cam
from compose import ease_fn

EASES = {"linear", "inQuad", "outQuad", "inOutQuad", "inCubic", "outCubic", "inOutCubic", "inSine", "outSine", "inOutSine", "inExpo", "outExpo"}


def load(d):
    data = json.loads(gzip.decompress(open(f"{d}/particle.data", "rb").read()))
    atlas = np.asarray(Image.open(f"{d}/particle.texture.png").convert("RGBA")).astype(np.float64) / 255
    return data, atlas


def to_px(x, y, W, H):
    nx = x * cam.JUDGE_HALF_X / 6
    ny = cam.HORIZON_Y + y * (cam.JUDGE_NDC_Y - cam.HORIZON_Y)
    return np.array((W / 2 * (1 + nx), H / 2 * (1 - ny)))


def expr(e, inp):
    return sum(v * inp.get(k, 0.0) for k, v in e.items())


def ev(p, q, inp):
    f, t = expr(p.get("from", {}), inp), expr(p.get("to", {}), inp)
    e = p.get("ease", "linear")
    return f + (t - f) * (ease_fn(e)(q) if e in EASES else q)


def draw(img, tile, quad, x, y, w, h, a):
    bl, tl, tr, br = quad
    def at(px, py):
        u = (px + 1) / 2; v = (py + 1) / 2
        b = bl + (br - bl) * u; t = tl + (tr - tl) * u
        return b + (t - b) * v
    p_tl, p_tr, p_bl = at(x - w, y + h), at(x + w, y + h), at(x - w, y - h)
    th, tw = tile.shape[:2]
    ex = (p_tr - p_tl) / tw; ey = (p_bl - p_tl) / th
    M = np.array([[ex[0], ey[0]], [ex[1], ey[1]]])
    if abs(np.linalg.det(M)) < 1e-12:
        return
    Mi = np.linalg.inv(M)
    p_br = p_tr + p_bl - p_tl
    xs = [p[0] for p in (p_tl, p_tr, p_bl, p_br)]; ys = [p[1] for p in (p_tl, p_tr, p_bl, p_br)]
    x0, x1 = max(0, int(min(xs))), min(img.shape[1], int(max(xs)) + 2)
    y0, y1 = max(0, int(min(ys))), min(img.shape[0], int(max(ys)) + 2)
    if x0 >= x1 or y0 >= y1:
        return
    X, Y = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
    d = np.stack([X - p_tl[0], Y - p_tl[1]], -1) @ Mi.T
    i, j = d[..., 0] - 0.5, d[..., 1] - 0.5
    m = (i >= -0.5) & (i < tw - 0.5) & (j >= -0.5) & (j < th - 0.5)
    i0 = np.clip(np.floor(i).astype(int), 0, tw - 1); j0 = np.clip(np.floor(j).astype(int), 0, th - 1)
    i1 = np.clip(i0 + 1, 0, tw - 1); j1 = np.clip(j0 + 1, 0, th - 1)
    fi = np.clip(i - np.floor(i), 0, 1)[..., None]; fj = np.clip(j - np.floor(j), 0, 1)[..., None]
    tex = (tile[j0, i0] * (1 - fi) + tile[j0, i1] * fi) * (1 - fj) + (tile[j1, i0] * (1 - fi) + tile[j1, i1] * fi) * fj
    al = tex[..., 3:4] * a * m[..., None]
    img[y0:y1, x0:x1, :3] = tex[..., :3] * al + img[y0:y1, x0:x1, :3] * (1 - al)


def render(data, atlas, names, t, duration, X0, Wn, bg, seed=1):
    img = bg.copy(); H_, W_ = img.shape[:2]
    rng = np.random.default_rng(seed)
    by = {e["name"]: e for e in data["effects"]}
    q = t / duration
    for n in names:
        e = by[n]
        quad = []
        for i in range(1, 5):
            inp = {"c": 1.0, "x1": X0, "y1": Wn}
            quad.append(to_px(expr(e["transform"][f"x{i}"], inp), expr(e["transform"][f"y{i}"], inp), W_, H_))
        for g in e["groups"]:
            for _ in range(g["count"]):
                r = rng.random(8)
                inp = {"c": 1.0}
                for k in range(8):
                    inp[f"r{k+1}"] = r[k]; inp[f"sinr{k+1}"] = math.sin(2 * math.pi * r[k]); inp[f"cosr{k+1}"] = math.cos(2 * math.pi * r[k])
                for p in g["particles"]:
                    if not (p["start"] <= q <= p["start"] + p["duration"]):
                        continue
                    u = (q - p["start"]) / p["duration"]
                    s = atlas_tile(data, atlas, p["sprite"])
                    draw(img, s, quad, ev(p["x"], u, inp), ev(p["y"], u, inp), ev(p["w"], u, inp), ev(p["h"], u, inp), max(0, min(1, ev(p["a"], u, inp))))
    return img


_cache = {}


def atlas_tile(data, atlas, i):
    if i not in _cache:
        s = data["sprites"][i]
        _cache[i] = atlas[s["y"]:s["y"] + s["h"], s["x"]:s["x"] + s["w"]]
    return _cache[i]
