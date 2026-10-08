"""HDR emission + URP bloom baked into straight-alpha tiles ("emission on black").

MobileAddHdrColor: rgb = vertex.rgb * tint.rgb^2 * 2 * tex.rgb, a = round(vertex.a * tint.a^2 * 2 * 255)/255 * tex.a,
blended SrcAlpha/One. LiveGameVolume Bloom: threshold 1.2, intensity 5, scatter .7, 5 iterations, no tonemapping.
Bloom radii are in 1080p screen pixels; tiles are rasterised at a screen-equivalent density so the halo is
isotropic on screen even though the tile lives in a foreshortened plane."""
import numpy as np
from scipy.ndimage import gaussian_filter, map_coordinates
from PIL import Image

LINEAR = __import__('os').environ.get('FX_LINEAR', '1') == '1'
THRESHOLD = 1.2 ** 2.2 if LINEAR else 1.2
KNEE = THRESHOLD * 0.5
INTENSITY = float(__import__('os').environ.get('FX_BLOOM', '5'))
SCATTER = 0.05 + 0.9 * 0.7
SIGMAS = [1, 4, 9, 18]
WEIGHTS = [(1 - SCATTER) * SCATTER ** i if i < len(SIGMAS) - 1 else SCATTER ** i for i in range(len(SIGMAS))]
PAD_SIGMA = 2.5
GAIN = float(__import__('os').environ.get('FX_GAIN', '7'))
BG = (0.16, 0.15, 0.26)  # typical live stage behind the lane (sRGB)


def to_lin(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4) if LINEAR else c


def to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055) if LINEAR else c


def hdr_gain(vertex_rgba, tint_rgba):
    """Linear additive emission per unit texel (rgb * alpha)."""
    v = np.array(vertex_rgba[:3]); t = np.array(tint_rgba[:3])
    # Vertex colours are authored in gamma and converted; HDR tints are stored linear (Unity's HDR picker).
    rgb = to_lin(v) * t * t * 2 if LINEAR else v * t * t * 2
    a = round(min(1.0, vertex_rgba[3] * tint_rgba[3] ** 2 * 2) * 255) / 255
    return rgb * a * GAIN


def bloom(img, px_per_screen_px):
    """img: HxWx3 linear emission. Sigmas scale with tile density (tile px per 1080p screen px), per axis."""
    sx, sy = px_per_screen_px
    b = np.max(img, axis=2)
    soft = np.clip(b - THRESHOLD + KNEE, 0, 2 * KNEE) ** 2 / (4 * KNEE + 1e-4)
    mult = np.maximum(soft, b - THRESHOLD) / np.maximum(b, 1e-4)
    pre = img * mult[..., None]
    out = np.zeros_like(img)
    for s, w in zip(SIGMAS, WEIGHTS):
        out += w * np.stack([gaussian_filter(pre[..., c], (s * sy, s * sx), mode="constant") for c in range(3)], axis=2)
    return img + INTENSITY * out


def pad_px(px_per_screen_px):
    return int(np.ceil(PAD_SIGMA * SIGMAS[-1] * max(px_per_screen_px)))


def sample(tex, uv, w, h):
    """Bilinear sample of tex (HxWx4 float, row 0 = image top) over uv=(u0,v0,u1,v1) (v up) into w x h."""
    th, tw = tex.shape[:2]
    u0, v0, u1, v1 = uv
    xs = (u0 + (np.arange(w) + 0.5) / w * (u1 - u0)) * tw - 0.5
    ys = (1 - (v1 - (np.arange(h) + 0.5) / h * (v1 - v0))) * th - 0.5
    X, Y = np.meshgrid(xs, ys)
    return np.stack([map_coordinates(tex[..., c], [Y, X], order=1, mode="nearest") for c in range(4)], axis=2)


def bake(emission_img, density, pads=(True, True, True, True)):
    """emission_img: HxWx3 linear additive emission at `density` tile px per screen px (x, y).
    pads: left, right, bottom, top. Returns (RGBA uint8 straight alpha, pad pixels per side)."""
    p = pad_px(density)
    l, r, b, t = (p if s else 0 for s in pads)
    h, w = emission_img.shape[:2]
    canvas = np.zeros((h + t + b, w + l + r, 3))
    canvas[t:t + h, l:l + w] = emission_img
    final = bloom(canvas, density)
    # Sonolus blends straight alpha. Encode what additive blending shows over a typical dark stage (BG), then
    # solve colour/alpha that reproduce it over BG: brighter stages darken slightly, dark ones match.
    bg = np.asarray(BG)
    target = to_srgb(to_lin(bg)[None, None, :] + final) if LINEAR else np.clip(bg[None, None, :] + final, 0, 1)
    a = np.max(np.clip((target - bg) / np.maximum(1 - bg, 1e-3), 0, 1), axis=2)
    rgb = np.where(a[..., None] > 1e-6, np.clip((target - bg * (1 - a[..., None])) / np.maximum(a[..., None], 1e-6), 0, 1), 0)
    out = np.concatenate([rgb, a[..., None]], axis=2)
    # Trim transparent margins (keeps the tile small) and report the trimmed pads.
    mask = a > 1 / 255
    if not mask.any():
        return None, (0, 0, 0, 0)
    rows = np.where(mask.any(axis=1))[0]; cols = np.where(mask.any(axis=0))[0]
    y0, y1 = (min(rows[0], t), max(rows[-1] + 1, t + h)) if True else (0, canvas.shape[0])
    x0, x1 = (min(cols[0], l), max(cols[-1] + 1, l + w))
    if not pads[3]: y0 = 0
    if not pads[2]: y1 = canvas.shape[0]
    if not pads[0]: x0 = 0
    if not pads[1]: x1 = canvas.shape[1]
    out = out[y0:y1, x0:x1]
    return (np.round(out * 255).astype(np.uint8)), (l - x0, x1 - (l + w), y1 - (t + h), t - y0)
