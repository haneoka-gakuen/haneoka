"""LiveGameCamera from scene_live: position (0, 10, 0), pitch 29.604 deg, vertical FOV 54.
Lane 19.12 wide (12 lanes), judgement root z = 9.62."""
import math

H = 10.0
PITCH = math.radians(29.60445665468814)
S, C = math.sin(PITCH), math.cos(PITCH)
TAN = math.tan(math.radians(27))
LANE_WIDTH = 19.12000084
LANE_UNIT = LANE_WIDTH / 12  # world units per lane
JUDGE_Z = 9.62


def ndc(X, Y, Z, aspect=16 / 9):
    depth = H * S - Y * S + Z * C
    up = (Y - H) * C + Z * S
    return X / depth / TAN / aspect, up / depth / TAN


def screen(X, Y, Z, width=1920, height=1080):
    nx, ny = ndc(X, Y, Z, width / height)
    return width / 2 * (1 + nx), height / 2 * (1 - ny)


HORIZON_Y = S / C / TAN  # ndc y of the ground vanishing point
_, JUDGE_NDC_Y = ndc(0, 0, JUDGE_Z)
JUDGE_HALF_X = (LANE_WIDTH / 2) / (H * S + JUDGE_Z * C) / TAN / (16 / 9)


def stage(X, Y, Z):
    """Sonolus stage space of the engine (x in lane units at the judgement line, y 0 at horizon, 1 at judgement)."""
    nx, ny = ndc(X, Y, Z)
    return nx * 6 / JUDGE_HALF_X, (ny - HORIZON_Y) / (JUDGE_NDC_Y - HORIZON_Y)
