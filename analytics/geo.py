"""Linear referencing helpers for shapes in EPSG:3765."""

from functools import lru_cache

import numpy as np
import shapely
from pyproj import Transformer

from . import METRIC_CRS

_to_metric = Transformer.from_crs("EPSG:4326", METRIC_CRS, always_xy=True)
_to_wgs84 = Transformer.from_crs(METRIC_CRS, "EPSG:4326", always_xy=True)

DENSIFY_STEP_M = 2.0


def to_metric(lon, lat):
    return _to_metric.transform(np.asarray(lon), np.asarray(lat))


def to_wgs84(x, y):
    return _to_wgs84.transform(np.asarray(x), np.asarray(y))


class DenseShape:
    """A shape sampled every DENSIFY_STEP_M metres, for fast windowed nearest-point search.

    Searching a window of the samples instead of projecting onto the whole line is
    what lets loops and out-and-back routes work: a point is only matched to the
    part of the shape where the vehicle can plausibly be.
    """

    def __init__(self, line: shapely.LineString):
        self.line = line
        self.length = line.length
        self.d = np.arange(0.0, self.length + DENSIFY_STEP_M, DENSIFY_STEP_M)
        self.d[-1] = self.length
        pts = shapely.line_interpolate_point(line, self.d)
        coords = shapely.get_coordinates(pts)
        self.x = coords[:, 0]
        self.y = coords[:, 1]

    def _range(self, d_min, d_max):
        i0 = max(0, int(np.floor(d_min / DENSIFY_STEP_M)))
        i1 = min(len(self.d), int(np.ceil(d_max / DENSIFY_STEP_M)) + 1)
        return i0, i1

    def nearest_in_window(self, x, y, d_min, d_max):
        """(distance along, offset) of the closest sample with d in [d_min, d_max]."""
        i0, i1 = self._range(d_min, d_max)
        if i1 <= i0:
            return None, np.inf
        dist = np.hypot(self.x[i0:i1] - x, self.y[i0:i1] - y)
        k = int(np.argmin(dist))
        return float(self.d[i0 + k]), float(dist[k])

    def candidates(self, x, y, max_offset):
        """Local minima of the distance profile closer than max_offset: one per pass of the shape near the point."""
        dist = np.hypot(self.x - x, self.y - y)
        close = dist <= max_offset
        if not close.any():
            return []
        # Split the close samples into contiguous runs and take each run's minimum.
        idx = np.flatnonzero(close)
        breaks = np.flatnonzero(np.diff(idx) > 1) + 1
        out = []
        for run in np.split(idx, breaks):
            k = run[int(np.argmin(dist[run]))]
            out.append((float(self.d[k]), float(dist[k])))
        return out


@lru_cache(maxsize=4096)
def _cached_dense(key, wkb):
    return DenseShape(shapely.from_wkb(wkb))


def dense_shape(shape_id, wkb):
    return _cached_dense(shape_id, wkb)


def locate_stops_on_shape(shape: DenseShape, xs, ys, max_offset=60.0):
    """Distance along the shape for each stop in order, monotonic.

    The feed has no shape_dist_traveled, so this picks, per stop, one of the
    shape's close passes such that the sequence is non-decreasing and the total
    offset is minimal (small DP over candidates). Stops with no pass within
    max_offset fall back to the global nearest, clamped to keep monotonicity.
    """
    cands = []
    for x, y in zip(xs, ys):
        c = shape.candidates(x, y, max_offset)
        if not c:
            d, off = shape.nearest_in_window(x, y, 0, shape.length)
            c = [(d, off)]
        cands.append(c)

    # DP: best[i][j] = minimal cost ending at candidate j of stop i.
    inf = float("inf")
    best = [[off for _, off in cands[0]]]
    back = [[-1] * len(cands[0])]
    for i in range(1, len(cands)):
        row, brow = [], []
        for d, off in cands[i]:
            cost, arg = inf, -1
            for j, (pd_, _) in enumerate(cands[i - 1]):
                if pd_ <= d + 1e-6 and best[i - 1][j] < cost:
                    cost, arg = best[i - 1][j], j
            if arg == -1:
                # No monotonic predecessor; allow it with a penalty so the chain doesn't break.
                arg = int(np.argmin(best[i - 1]))
                cost = best[i - 1][arg] + 1000.0
            row.append(cost + off)
            brow.append(arg)
        best.append(row)
        back.append(brow)

    j = int(np.argmin(best[-1]))
    result = [0.0] * len(cands)
    offsets = [0.0] * len(cands)
    for i in range(len(cands) - 1, -1, -1):
        result[i], offsets[i] = cands[i][j]
        j = back[i][j]
    # Enforce monotonicity for any penalised fallbacks.
    result = np.maximum.accumulate(np.array(result))
    return result, np.array(offsets)
