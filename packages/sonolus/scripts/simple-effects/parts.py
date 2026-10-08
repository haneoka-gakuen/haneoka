"""Effect parts of one effect001 prefab under one animator clip, in world units relative to the effect
root (lane centre on the judgement line). Widths follow LiveNoteEffectAsset.SetWidth: frame size.x = W + 0.4,
wall scale.x = W - 0.15, pillars at -W/2 / +W/2, emitter shape scale.x = W + offset."""
import json, math, os
from spec import ROOT, load_nodes, load_clip, comp
from emit import simulate, mm_eval, grad_eval

FPS = 60


def color_of(c):
    return (c["r"], c["g"], c["b"], c["a"])


class Track:
    """A per-frame sampled scalar over [0, stop]."""
    def __init__(self, values):
        self.values = values

    def at(self, i):
        return self.values[min(i, len(self.values) - 1)]


def node_track(curves, path, attr, static, n, stop):
    cur = curves.get((path, attr))
    if cur is None:
        return Track([static] * n)
    return Track([cur(i / FPS) for i in range(n)])


def asset_params(nodes):
    mb = [c for c in nodes["^"]["components"] if c["type"] == "MonoBehaviour"][0]["tree"]
    return mb


def width_rules(nodes):
    """Map node path -> SetWidth rule, resolved by component path ids."""
    mb = asset_params(nodes)
    by_pid = {}
    for path, node in nodes.items():
        for c in node["components"]:
            by_pid[c.get("path_id")] = path
    return mb


def extract(prefab, clip, loop=False):
    nodes = load_nodes(prefab)
    stop, curves = load_clip(prefab, clip, nodes) if clip else (1.0, {})
    n = int(round(stop * FPS)) + 1
    parts = []
    root_active = node_track(curves, "", "m_IsActive", 1.0, n, stop)

    def active_track(path):
        # A node renders while it and every ancestor are active.
        segs = path.split("/") if path else []
        tr = [1.0] * n
        for k in range(1, len(segs) + 1):
            p = "/".join(segs[:k])
            node = nodes[p]
            t = node_track(curves, p, "m_IsActive", 1.0 if node["active"] else 0.0, n, stop)
            tr = [a * (1.0 if b > 0.5 else 0.0) for a, b in zip(tr, t.values)]
        return tr

    for path, node in sorted(nodes.items()):
        if path == "^": continue
        tf = comp(node, "Transform")[0]
        pos = tf["m_LocalPosition"]; scl = tf["m_LocalScale"]; rot = tf["m_LocalRotation"]
        act = active_track(path)
        if not any(act):
            continue
        sr = comp(node, "SpriteRenderer")
        if sr:
            sr = sr[0]
            col = color_of(sr["m_Color"])
            tr = {ch: node_track(curves, path, f"m_Color.{ch}", col[i], n, stop) for i, ch in enumerate("rgba")}
            sx = node_track(curves, path, "m_Size.x", sr["m_Size"]["x"], n, stop)
            sy = node_track(curves, path, "m_Size.y", sr["m_Size"]["y"], n, stop)
            flat = abs(rot["x"] - 0.7071) < 0.01
            parts.append(dict(kind="frame" if flat else "pillar", path=path, pos=pos, scale=scl, active=act,
                              rgb=[[tr[c].at(i) for c in "rgb"] for i in range(n)], alpha=[tr["a"].at(i) for i in range(n)],
                              size=[(sx.at(i), sy.at(i)) for i in range(n)]))
            continue
        ps = comp(node, "ParticleSystem")
        if not ps:
            continue
        ps = ps[0]
        if not ps["EmissionModule"].get("enabled"):
            continue
        rend = comp(node, "ParticleSystemRenderer")[0]
        ini = ps["InitialModule"]
        mc = {ch: node_track(curves, path, f"InitialModule.startColor.maxColor.{ch}", ini["startColor"]["maxColor"][ch], n, stop) for ch in "rgba"}
        simspd = node_track(curves, path, "simulationSpeed", ps.get("simulationSpeed", 1.0), n, stop)
        # Active window: first..last active frame.
        on = [i for i, a in enumerate(act) if a]
        window = (on[0] / FPS, (on[-1] + 1) / FPS if on[-1] < n - 1 or not loop else stop)
        parts.append(dict(kind="wall" if rend["m_RenderMode"] == 4 else "emitter", path=path, pos=pos, scale=scl, ps=ps,
                          renderer=rend, window=window, start_rgba=[[mc[c].at(i) for c in "rgba"] for i in range(n)],
                          simspeed=simspd.values, active=act))
    return dict(prefab=prefab, clip=clip, stop=stop, frames=n, parts=parts, asset=asset_params(nodes))
