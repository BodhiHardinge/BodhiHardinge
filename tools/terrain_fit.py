"""
Surface clean-up for course heights.

Lidar at about 2 ground points per m² measures each square metre to within a few centimetres, which is enough
for the shape of a hole but makes a green look bumpy: slopes from point noise alone reach several percent. Greens
are fitted with a local quadratic surface (weighted least squares in a Gaussian window), which removes the noise
but keeps real tiers and ridges far better than plain blurring would.
"""
import numpy as np
from scipy import ndimage


def local_quadratic(z, weight, sigma):
    """Weighted local quadratic fit of a height grid; returns the fitted surface at every cell."""
    r = int(np.ceil(3 * sigma))
    u, v = np.meshgrid(np.arange(-r, r + 1), np.arange(-r, r + 1))  # u along columns (x), v along rows
    g = np.exp(-(u ** 2 + v ** 2) / (2 * sigma ** 2))
    basis = [np.ones_like(u, dtype=float), u, v, u * u, u * v, v * v]
    w = np.nan_to_num(weight)
    wz = w * np.nan_to_num(z)
    n = len(basis)
    A = np.zeros(z.shape + (n, n))
    b = np.zeros(z.shape + (n,))
    for i in range(n):
        b[..., i] = ndimage.correlate(wz, g * basis[i], mode='nearest')
        for j in range(i, n):
            A[..., i, j] = A[..., j, i] = ndimage.correlate(w, g * basis[i] * basis[j], mode='nearest')
    # A tiny ridge term keeps sparse cells solvable; it pulls the curvature terms toward zero, never the height.
    A[..., 3, 3] += 1e-3
    A[..., 4, 4] += 1e-3
    A[..., 5, 5] += 1e-3
    A[..., 1, 1] += 1e-6
    A[..., 2, 2] += 1e-6
    sol = np.linalg.solve(A, b[..., None])[..., 0]
    return sol[..., 0]


def blend(base, fitted, mask, width):
    """Uses `fitted` inside the mask, fading back to `base` over `width` metres outside it."""
    d = ndimage.distance_transform_edt(~mask)
    t = np.clip(1 - d / width, 0, 1)
    t = t * t * (3 - 2 * t)
    return base * (1 - t) + fitted * t


def planar_greens(heights, labels, max_slope):
    """For coarse terrain: each green becomes a best-fit plane, tilted no more than max_slope (rise over run)."""
    out = heights.copy()
    rows, cols = np.indices(heights.shape)
    for k in range(1, labels.max() + 1):
        m = labels == k
        if m.sum() < 10:
            continue
        X = np.column_stack([np.ones(m.sum()), cols[m], rows[m]])
        coef, *_ = np.linalg.lstsq(X, heights[m], rcond=None)
        gx, gy = coef[1], coef[2]
        s = np.hypot(gx, gy)
        if s > max_slope:
            gx, gy = gx * max_slope / s, gy * max_slope / s
        cx, cy = cols[m].mean(), rows[m].mean()
        out[m] = heights[m].mean() + gx * (cols[m] - cx) + gy * (rows[m] - cy)
    return out
