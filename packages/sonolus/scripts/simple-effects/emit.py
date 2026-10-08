"""Unity ParticleSystem emulation for the effect emitters (shape box, rate curve, lifetime,
velocity-over-lifetime with limit/drag, size and colour over lifetime, simulation speed)."""
import math, random
def mm_eval(x, t, r):
    st = x["minMaxState"]; sc = x.get("scalar", 0.0)
    if st == 0: return sc
    if st == 3: return x.get("minScalar", 0.0) + (sc - x.get("minScalar", 0.0)) * r
    def curve(c, t):
        ks = c["m_Curve"]
        if not ks: return 0.0
        if t <= ks[0]["time"]: return ks[0]["value"]
        for a, b in zip(ks, ks[1:]):
            if a["time"] <= t <= b["time"]:
                dt = b["time"] - a["time"]; u = (t - a["time"]) / dt if dt > 0 else 0
                m0 = a["outSlope"] * dt; m1 = b["inSlope"] * dt
                if not math.isfinite(m0) or not math.isfinite(m1): return a["value"]
                h00 = 2*u**3 - 3*u**2 + 1; h10 = u**3 - 2*u**2 + u; h01 = -2*u**3 + 3*u**2; h11 = u**3 - u**2
                return h00*a["value"] + h10*m0 + h01*b["value"] + h11*m1
        return ks[-1]["value"]
    if st == 1: return sc * curve(x["maxCurve"], t)
    return sc * (curve(x["minCurve"], t) + (curve(x["maxCurve"], t) - curve(x["minCurve"], t)) * r)

def grad_eval(g, t):
    """MinMaxGradient (mode 1 gradient): rgb, a at t."""
    gr = g["maxGradient"]
    def interp(keys):
        if t <= keys[0][1]: return keys[0][0]
        for (v0, t0), (v1, t1) in zip(keys, keys[1:]):
            if t0 <= t <= t1:
                u = (t - t0) / (t1 - t0) if t1 > t0 else 0
                return tuple(a + (b - a) * u for a, b in zip(v0, v1)) if isinstance(v0, tuple) else v0 + (v1 - v0) * u
        return keys[-1][0]
    ck = [((gr[f"key{i}"]["r"], gr[f"key{i}"]["g"], gr[f"key{i}"]["b"]), gr[f"ctime{i}"] / 65535) for i in range(gr["m_NumColorKeys"])]
    ak = [(gr[f"key{i}"]["a"], gr[f"atime{i}"] / 65535) for i in range(gr["m_NumAlphaKeys"])]
    return interp(ck), interp(ak)

def simulate(ps, node_scale_x, width_shape_x, active, seed=1, dt_real=1/120, sim_speed=None, loop=False):
    """Return list of particles: each a dict with birth (real s) and samples [(t_real, x, y, z, sx, sy, rgb_mul, a_mul)]
    in the node's local space; particles die at their lifetime end or when the node deactivates (active[1])."""
    rnd = random.Random(seed)
    ini = ps["InitialModule"]; em = ps["EmissionModule"]; sh = ps["ShapeModule"]
    sp = sim_speed if sim_speed is not None else ps.get("simulationSpeed", 1.0)
    L = ps["lengthInSec"]; loop = ps["looping"]
    t_on, t_off = active
    parts = []; acc = 0.0; t = t_on; burst_done = set()
    vel = ps.get("VelocityModule", {}); clamp = ps.get("ClampVelocityModule", {}); size = ps.get("SizeModule", {}); col = ps.get("ColorModule", {})
    while t < t_off:
        sys_t = (t - t_on) * sp
        if loop: sys_t = sys_t % L
        elif sys_t >= L: break
        if em.get("enabled"):
            acc += mm_eval(em["rateOverTime"], sys_t / L, rnd.random()) * sp * dt_real
            for bi, b in enumerate(em["m_Bursts"]):
                if bi not in burst_done and sys_t >= b["time"]:
                    burst_done.add(bi); acc += b["countCurve"].get("scalar", 0)
        while acc >= 1:
            acc -= 1
            r = [rnd.random() for _ in range(8)]
            life = mm_eval(ini["startLifetime"], sys_t / L, r[0])
            s0 = mm_eval(ini["startSize"], sys_t / L, r[1]); s0y = mm_eval(ini["startSizeY"], sys_t / L, r[1]) if ini.get("size3D") else s0
            # Box shape (type 5) in the node: scale x set by SetWidth, y/z as authored; rotation x=90 lays it on the ground.
            x0 = (r[2] - 0.5) * (width_shape_x if sh.get("enabled") else 0)
            sy, sz = sh["m_Scale"]["y"], sh["m_Scale"]["z"]
            if sh.get("enabled") and sh["type"] == 5 and abs(sh["m_Rotation"]["x"] - 90) < 1: y0, z0 = (r[3]-0.5) * sz, (r[3]-0.5) * sy
            elif sh.get("enabled") and sh["type"] == 5: y0, z0 = (r[3]-0.5) * sy, (r[4]-0.5) * sz
            else: y0, z0 = 0.0, 0.0
            vy0 = mm_eval(vel["y"], 0, r[5]) if vel.get("enabled") else 0.0
            p = {"birth": t, "life_sim": life, "samples": [], "x": x0}
            # integrate in sim time
            age = 0.0; y = y0; v = vy0; tr = t
            while age < life and (loop or tr < t_off):
                u = age / life
                if vel.get("enabled"): v_target = mm_eval(vel["y"], u, r[5])
                else: v_target = 0.0
                if clamp.get("enabled"):
                    lim = mm_eval(clamp["magnitude"], u, r[6])
                    damp = clamp.get("dampen", 0.0)
                    # Unity: velocity above the limit decays by `dampen` per 1/30 s of simulation.
                    if abs(v_target) > lim:
                        k = 1 - (1 - damp) ** (dt_real * sp * 30)
                        v = v + (math.copysign(lim, v_target) - v) * k if abs(v) > lim else v
                    else: v = v_target if abs(v) <= lim else v
                    drag = mm_eval(clamp["drag"], u, r[7]) if "drag" in clamp else 0.0
                    v *= max(0.0, 1 - drag * dt_real * sp)
                else: v = v_target
                sx = s0 * (mm_eval(size["curve"], u, r[1]) if size.get("enabled") else 1)
                syv = s0y * (mm_eval(size["y"], u, r[1]) if size.get("enabled") and size.get("separateAxes") else (mm_eval(size["curve"], u, r[1]) if size.get("enabled") else 1))
                rgb, a = grad_eval(col["gradient"], u) if col.get("enabled") else ((1, 1, 1), 1.0)
                p["samples"].append((tr, x0, y, z0, sx, syv, sum(rgb) / 3, a))
                y += v * dt_real * sp; age += dt_real * sp; tr += dt_real
                if vel.get("enabled") and not clamp.get("enabled"): v = v_target
            p["death"] = tr; parts.append(p)
        t += dt_real
    return parts
