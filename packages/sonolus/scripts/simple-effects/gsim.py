"""Deterministic Unity ParticleSystem simulation for the effect001Simple emitters, in world units relative to the
effect root (lane centre on the judgement line), at one note width W.

Covers what these prefabs use: box and circle shapes (with shape rotation), rate over time / over distance /
bursts, simulation speed and start lifetime animated by the clip, node positions animated by the clip, local or
world simulation space, velocity over lifetime with limit (dampen, drag), separate-axis size, colour over
lifetime, and LiveNoteEffectAsset.SetWidth (shape scale x = W + o, transform scale x = W + o, range scale x =
lerp(min, max, W / lane width))."""
import json, math, random
import numpy as np
from emit import mm_eval, grad_eval
import spec

LANE_WIDTH = 19.12000084


def _rot_x(v, deg):
    a = math.radians(deg)
    x, y, z = v
    return (x, y * math.cos(a) - z * math.sin(a), y * math.sin(a) + z * math.cos(a))


class Prefab:
    def __init__(self, prefab, clip, root):
        spec.ROOT = root
        self.nodes = spec.load_nodes(prefab)
        self.stop, self.curves = spec.load_clip(prefab, clip, self.nodes)
        mb = [c for c in self.nodes["^"]["components"] if c["type"] == "MonoBehaviour"][0]["tree"]
        ids = json.load(open(f"{root}/transform_ids.json"))[prefab]
        name = lambda pptr: ids.get(str(pptr["m_PathID"]))
        self.transform_w = {name(p["transform"]): p["scaleOffset"] for p in mb["_transformWidthSetParams"]}
        self.range_w = {name(p["transform"]): (p["min"], p["max"]) for p in mb["_transformWidthSetRangeParams"]}
        self.shape_w = {name(p["particleSystem"]): p["scaleOffset"] for p in mb["_particleShapeWidthSetParams"]}
        self.sprite_w = {name(p["spriteRenderer"]): p["sizeOffset"] for p in mb["_spriteRendererWidthSetParams"]}

    def static(self, path):
        tf = spec.comp(self.nodes[path], "Transform")[0]
        p, s = tf["m_LocalPosition"], tf["m_LocalScale"]
        return [p["x"], p["y"], p["z"]], [s["x"], s["y"], s["z"]]

    def curve(self, path, attr, default, t):
        c = self.curves.get((path, attr))
        return c(t) if c is not None else default

    def local(self, path, t, W):
        pos, scl = self.static(path)
        pos = [self.curve(path, f"position[{i}]", pos[i], t) for i in range(3)]
        scl = [self.curve(path, f"scale[{i}]", scl[i], t) for i in range(3)]
        if path in self.transform_w:
            scl[0] = W + self.transform_w[path]
        if path in self.range_w:
            lo, hi = self.range_w[path]
            scl[0] = lo + (hi - lo) * min(1.0, max(0.0, W / LANE_WIDTH))
        return pos, scl

    def rotation(self, path):
        tf = spec.comp(self.nodes[path], "Transform")[0]
        q = tf["m_LocalRotation"]
        x, y, z, w = q["x"], q["y"], q["z"], q["w"]
        return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])

    def world(self, path, t, W, with_rotation=False):
        """World position, scale and rotation of a node (Unity TRS chain, scale applied before rotation)."""
        segs = path.split("/")
        chain = [""] + ["/".join(segs[:k]) for k in range(1, len(segs) + 1)]
        P, S, R = np.zeros(3), np.ones(3), np.eye(3)
        for node in chain:
            if node == "":
                pos, scl = self.static("") if "" in self.nodes else ([0, 0, 0], [1, 1, 1])
                rot = self.rotation("") if "" in self.nodes else np.eye(3)
            else:
                pos, scl = self.local(node, t, W)
                rot = self.rotation(node)
            P = P + R @ (S * np.array(pos))
            R = R @ rot
            S = S * np.array(scl)
        return (list(P), list(S), R) if with_rotation else (list(P), list(S))

    def active(self, path, t):
        segs = path.split("/")
        for k in range(1, len(segs) + 1):
            p = "/".join(segs[:k])
            default = 1.0 if self.nodes[p]["active"] else 0.0
            if self.curve(p, "m_IsActive", default, t) < 0.5:
                return False
        return True


def simulate(pf, path, W, t_end, dt=1 / 240, seed=11, loop_window=None):
    ps = spec.comp(pf.nodes[path], "ParticleSystem")[0]
    ini, em, sh = ps["InitialModule"], ps["EmissionModule"], ps["ShapeModule"]
    vel, clamp, size, col = ps.get("VelocityModule", {}), ps.get("ClampVelocityModule", {}), ps.get("SizeModule", {}), ps.get("ColorModule", {})
    L, loop = ps["lengthInSec"], ps["looping"]
    world_space = ps["moveWithTransform"] == 1
    rnd = random.Random(seed)
    parts, alive = [], []
    sys_t, acc, playing, last_pos, bursts_done = 0.0, 0.0, False, None, set()
    t = 0.0
    while t < t_end:
        act = pf.active(path, t)
        spd = pf.curve(path, "simulationSpeed", ps.get("simulationSpeed", 1.0), t)
        npos, nscl, nrot = pf.world(path, t, W, True)
        if act and not playing:
            playing, sys_t, last_pos, bursts_done = True, 0.0, npos, set()
        if not act:
            playing = False
        if playing and (loop or sys_t < L):
            u = (sys_t % L) / L if loop else sys_t / L
            rate = mm_eval(em["rateOverTime"], u, 0.5) if em.get("enabled") else 0.0
            rate_scale = pf.curve(path, "EmissionModule.rateOverTime.scalar", None, t)
            if rate_scale is not None and em["rateOverTime"]["minMaxState"] == 0:
                rate = rate_scale
            acc += rate * spd * dt
            if em.get("enabled"):
                dist = pf.curve(path, "EmissionModule.rateOverDistance.scalar", mm_eval(em["rateOverDistance"], u, 0.5), t)
                if dist > 0 and world_space:
                    acc += dist * math.dist(npos, last_pos)
                for bi, b in enumerate(em["m_Bursts"]):
                    if bi not in bursts_done and sys_t >= b["time"]:
                        bursts_done.add(bi); acc += b["countCurve"].get("scalar", 0)
            while acc >= 1:
                acc -= 1
                r = [rnd.random() for _ in range(10)]
                life = mm_eval(ini["startLifetime"], u, r[0])
                ls = pf.curve(path, "InitialModule.startLifetime.scalar", None, t)
                if ls is not None and ini["startLifetime"]["minMaxState"] == 0:
                    life = ls
                s0 = mm_eval(ini["startSize"], u, r[1])
                s0y = mm_eval(ini["startSizeY"], u, r[1]) if ini.get("size3D") else s0
                v0 = mm_eval(ini["startSpeed"], u, r[2])
                # shape
                off, d = (0.0, 0.0, 0.0), (0.0, 0.0, 1.0)
                if sh.get("enabled"):
                    sx, sy, sz = sh["m_Scale"]["x"], sh["m_Scale"]["y"], sh["m_Scale"]["z"]
                    if path in pf.shape_w:
                        sx = W + pf.shape_w[path]
                    if sh["type"] == 5:  # box, emits along +z
                        off = ((r[3] - 0.5) * sx, (r[4] - 0.5) * sy, (r[5] - 0.5) * sz)
                        d = (0.0, 0.0, 1.0)
                    elif sh["type"] == 10:  # circle in XY, radial
                        rad = sh["radius"]["value"] * math.sqrt(r[3]); th = 2 * math.pi * r[4]
                        off = (rad * math.cos(th) * sx, rad * math.sin(th) * sy, 0.0)
                        n = math.hypot(math.cos(th) * sx, math.sin(th) * sy) or 1.0
                        d = (math.cos(th) * sx / n, math.sin(th) * sy / n, 0.0)
                    off = _rot_x(off, sh["m_Rotation"]["x"]); d = _rot_x(d, sh["m_Rotation"]["x"])
                scale_k = nscl if ps.get("scalingMode", 1) == 0 else pf.local(path, t, W)[1]
                off = tuple(nrot @ (np.array(off) * np.array(scale_k)))
                sign = [1.0 if nscl[k] >= 0 else -1.0 for k in range(3)]
                d = tuple(nrot @ (np.array(d) * np.array(sign)))
                vrnd = (r[6], r[7], r[8])
                start = [npos[k] + off[k] for k in range(3)] if world_space else list(off)
                alive.append({"birth": t, "life": max(life, 1e-3), "age": 0.0, "pos": start, "v": [d[k] * v0 for k in range(3)], "rot": nrot,
                              "vrnd": vrnd, "s0": (s0, s0y), "sign": sign, "track": []})
            sys_t += spd * dt
        last_pos = npos
        # update
        for p in list(alive):
            u = p["age"] / p["life"]
            if u >= 1:
                alive.remove(p); parts.append(p); continue
            if vel.get("enabled"):
                vl = np.array([mm_eval(vel[a], u, p["vrnd"][i]) * p["sign"][i] for i, a in enumerate("xyz")])
                vv = list(vl if vel.get("inWorldSpace") else p["rot"] @ vl)
            else:
                vv = [0.0, 0.0, 0.0]
            # Unity: Limit Velocity and its drag act on the particle's own velocity (start speed, forces); the
            # Velocity over Lifetime module is animated velocity added on top and is never limited.
            if clamp.get("enabled"):
                lim = mm_eval(clamp["magnitude"], u, 0.5)
                mag = math.sqrt(sum(x * x for x in p["v"]))
                if mag > lim and mag > 0:
                    k_ = 1 - (1 - clamp.get("dampen", 0)) ** (spd * dt * 30)
                    p["v"] = [x + (x * lim / mag - x) * k_ for x in p["v"]]
                drag = mm_eval(clamp["drag"], u, 0.5) if "drag" in clamp else 0.0
                f = max(0.0, 1 - drag * spd * dt)
                p["v"] = [x * f for x in p["v"]]
            v = [p["v"][k] + vv[k] for k in range(3)]
            sx = p["s0"][0] * (mm_eval(size["curve"], u, 0.5) if size.get("enabled") else 1.0)
            sy = p["s0"][1] * (mm_eval(size["y"] if size.get("separateAxes") else size["curve"], u, 0.5) if size.get("enabled") else 1.0)
            if size.get("enabled") and size.get("separateAxes"):
                sy = p["s0"][0] * mm_eval(size["y"], u, 0.5)
            rgb, a = grad_eval(col["gradient"], u) if col.get("enabled") else ((1, 1, 1), 1.0)
            wp = p["pos"] if world_space else [npos[k] + p["pos"][k] for k in range(3)]
            p["track"].append((t, wp[0], wp[1], wp[2], abs(sx), abs(sy), float(np.mean(rgb)) * a))
            p["pos"] = [p["pos"][k] + v[k] * spd * dt for k in range(3)]
            p["age"] += spd * dt
        t += dt
    return parts + alive, ps
