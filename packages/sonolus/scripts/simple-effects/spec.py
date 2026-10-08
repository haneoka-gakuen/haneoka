"""Effect spec from the decoded effect001 dumps: clip curves (exact Hermite), node rigs, emitter simulation."""
import json, struct, zlib, glob, os, math, random
ROOT = "/home/xuc/.claude/jobs/50d4d325/tmp/fxre/out/effect001"
def crc(s): return zlib.crc32(s.encode()) & 0xffffffff
ATTR_NAMES = ["m_IsActive", "EmissionModule.rateOverDistance.scalar", "InitialModule.startSpeed.scalar", "InitialModule.startSizeY.scalar","m_Size.x","m_Size.y","m_LocalScale.x","m_LocalScale.y","m_LocalPosition.x","m_LocalPosition.y","m_LocalPosition.z","simulationSpeed","InitialModule.simulationSpeed","EmissionModule.rateOverTime.scalar","InitialModule.startSize.scalar","InitialModule.startLifetime.scalar","ShapeModule.m_Scale.x"]
for b in ["m_Color","InitialModule.startColor.maxColor","InitialModule.startColor.minColor"]:
    for ch in "rgba": ATTR_NAMES.append(f"{b}.{ch}")
ATTRS = {crc(a): a for a in ATTR_NAMES}

class Curve:
    def __init__(self, segs, const=None): self.segs, self.const = segs, const
    def __call__(self, t):
        if self.const is not None: return self.const
        v = None
        for (t0, co) in self.segs:
            if t0 <= t or v is None:
                dt = max(0.0, t - t0) if t0 > -1e30 else 0.0
                a, b, c, d = co
                v = ((a*dt + b)*dt + c)*dt + d
            if t0 > t: break
        return v

def load_nodes(prefab):
    d = os.path.join(ROOT, prefab); nodes = {}
    for f in glob.glob(d + f"/{prefab}*.json"):
        j = json.load(open(f)); parts = j["name"].split("/")
        rel = "^" if len(parts) == 1 else "/".join(parts[2:])  # path below the animator root; "^" = prefab top
        nodes[rel] = j
    return nodes

def load_clip(prefab, clip, nodes):
    c = json.load(open(os.path.join(ROOT, prefab, f"CLIP_{clip}.json")))
    paths = {crc(p): p for p in nodes if p != "^"}
    cl = c["m_MuscleClip"]["m_Clip"]["data"]; s = cl["m_StreamedClip"]["data"]
    raw = struct.pack("<%dI" % len(s), *s); i = 0; segs = {}
    while i < len(raw):
        t, = struct.unpack_from("<f", raw, i); n, = struct.unpack_from("<I", raw, i+4); i += 8
        for _ in range(n):
            idx, = struct.unpack_from("<I", raw, i); co = struct.unpack_from("<4f", raw, i+4); i += 20
            if t < 1e30: segs.setdefault(idx, []).append((t, co))
    nstream = cl["m_StreamedClip"]["curveCount"]; dense = cl["m_DenseClip"]; const = cl["m_ConstantClip"]["data"]
    assert dense["m_CurveCount"] == 0
    out = {}; k = 0
    for b in c["m_ClipBindingConstant"]["genericBindings"]:
        dim = 3 if b["typeID"] == 4 and b["attribute"] in (1, 3, 4) else (4 if b["typeID"] == 4 and b["attribute"] == 2 else 1)
        path = paths.get(b["path"], f"?{b['path']}"); attr = ATTRS.get(b["attribute"], f"?{b['attribute']}")
        for j in range(dim):
            ix = k + j
            cur = Curve(segs.get(ix, [])) if ix < nstream else Curve([], const[ix - nstream])
            if dim == 1: out[(path, attr)] = cur
            elif b["typeID"] == 4 and b["attribute"] == 1: out[(path, f"position[{j}]")] = cur
            elif b["typeID"] == 4 and b["attribute"] == 3: out[(path, f"scale[{j}]")] = cur
        k += dim
    return c["m_MuscleClip"]["m_StopTime"], out

def comp(node, t):
    return [c["tree"] for c in node["components"] if c["type"] == t]
