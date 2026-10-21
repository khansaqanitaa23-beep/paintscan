#!/usr/bin/env python3
"""
paint_degradation_pipeline.py
=============================
Beginner-friendly computer-vision pipeline that measures the surface
percentage of fungal growth (mold), micro-cracking and paint peeling
in inspection photos.

This is the exact same pipeline as the PaintScan web app, ported 1:1
to Python + OpenCV. No training data is required: the "model" is
unsupervised k-means color clustering plus morphological filtering,
so it adapts automatically to each photo.

Pipeline
--------
1. Resize to a small analysis grid (fast, and averages out sensor noise)
2. Convert RGB -> CIE L*a*b* (perceptual color space)
3. k-means cluster pixels into 5 color groups
4. Classify clusters relative to the dominant (paint) cluster:
     darker + green-shifted  -> mold
     brighter + desaturated  -> peeling (exposed substrate)
5. Black-hat morphological transform + shape filtering -> cracks
6. Count pixels -> surface percentages; connected components -> regions

Usage
-----
    pip install opencv-python numpy
    python paint_degradation_pipeline.py photo1.jpg photo2.jpg ...
    python paint_degradation_pipeline.py wall.jpg --mold-sens 70 --out results/

Outputs
-------
* console table + CSV report with surface percentages
* overlay image per photo (defects tinted) saved next to the input
"""

import argparse
import csv
import sys
from pathlib import Path

import cv2
import numpy as np

# --- tuning constants -------------------------------------------------------
ANALYSIS_WIDTH = 480        # px, downscale target (like the web app)
K_CLUSTERS = 5              # color clusters for k-means
BLACKHAT_RADIUS_DIV = 120   # structuring element = width / 120 (min 2)
MIN_REGION_FRAC = 0.0005    # ignore specks smaller than 0.05 % of image

CLASS_COLORS_BGR = {        # for the overlay rendering (OpenCV uses BGR)
    "mold":  (41, 180, 240),    # amber
    "crack": (248, 189, 56),    # sky
    "peel":  (133, 113, 251),   # rose
}


def extract_features(bgr: np.ndarray):
    """Stage 1 (heavy): resize, color spaces, k-means, black-hat."""
    h, w = bgr.shape[:2]
    scale = min(1.0, ANALYSIS_WIDTH / w)
    small = cv2.resize(bgr, (round(w * scale), round(h * scale)),
                       interpolation=cv2.INTER_AREA)

    lab = cv2.cvtColor(small, cv2.COLOR_BGR2Lab).astype(np.float32)
    # OpenCV scales Lab to 0..255; approximate true L*a*b* ranges
    L, a, b = lab[..., 0] * (100 / 255), lab[..., 1] - 128, lab[..., 2] - 128
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    # --- k-means clustering (the "lightweight model") ----------------------
    Z = np.stack([L.ravel(), a.ravel() * (100 / 128), b.ravel() * (100 / 128)],
                 axis=1).astype(np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 12, 1.0)
    _, labels, centers = cv2.kmeans(
        Z, K_CLUSTERS, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
    labels = labels.ravel().reshape(L.shape)
    counts = np.bincount(labels.ravel(), minlength=K_CLUSTERS)

    # --- black-hat transform for cracks ------------------------------------
    r = max(2, round(small.shape[1] / BLACKHAT_RADIUS_DIV))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2 * r + 1, 2 * r + 1))
    blackhat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, kernel)

    # per-cluster mean Lab
    means = []
    for c in range(K_CLUSTERS):
        mask = labels == c
        means.append((L[mask].mean(), a[mask].mean(), b[mask].mean())
                     if mask.any() else (0, 0, 0))
    return small, labels, counts, np.array(means), blackhat


def classify(features, mold_sens=55, crack_sens=55, peel_sens=55):
    """Stage 2 (fast): classify clusters, threshold cracks, measure."""
    small, labels, counts, means, blackhat = features
    n = labels.size

    base = int(np.argmax(counts))                # dominant cluster = paint
    base_is_mold = means[base][0] < 38           # surface dominated by mold
    paint_ref = base
    if base_is_mold:
        # use the brightest sizeable cluster as the paint reference
        cand = [c for c in range(len(counts))
                if c != base and counts[c] > n * 0.03]
        if cand:
            paint_ref = max(cand, key=lambda c: means[c][0])

    mold_t = 30 - mold_sens * 0.22               # sensitivity -> thresholds
    peel_t = 30 - peel_sens * 0.22
    crack_t = 26 - crack_sens * 0.18

    base_chroma = np.hypot(means[paint_ref][1], means[paint_ref][2])
    cluster_class = ["intact"] * len(counts)
    for c in range(len(counts)):
        if c == base:
            cluster_class[c] = "mold" if base_is_mold else "intact"
            continue
        Lc, ac, bc = means[c]
        dL = Lc - means[paint_ref][0]
        green_shift = means[paint_ref][1] - ac
        chroma = np.hypot(ac, bc)
        mold_score = max(0, -dL) + max(0, green_shift) * 1.5 + (8 if Lc < 42 else 0)
        peel_score = (max(0, dL) + max(0, base_chroma - chroma) * 0.8
                      + (6 if chroma < 14 and dL > 4 else 0))
        if mold_score > mold_t and mold_score >= peel_score:
            cluster_class[c] = "mold"
        elif peel_score > peel_t:
            cluster_class[c] = "peel"

    # combine clusters per class (there may be several)
    mold_mask = np.isin(labels, [i for i, k in enumerate(cluster_class)
                                 if k == "mold"]).astype(np.uint8)
    peel_mask = np.isin(labels, [i for i, k in enumerate(cluster_class)
                                 if k == "peel"]).astype(np.uint8)

    # speckle removal (morphological opening)
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    mold_mask = cv2.morphologyEx(mold_mask, cv2.MORPH_OPEN, k3)
    peel_mask = cv2.morphologyEx(peel_mask, cv2.MORPH_OPEN, k3)

    # peel-patch edges cast thin shadows that mimic cracks — suppress crack
    # pixels within 2px of a peeling region
    peel_halo = cv2.dilate(peel_mask, k3, iterations=2)

    # cracks: threshold black-hat, keep thin/elongated components only
    crack_mask = np.zeros_like(mold_mask)
    raw = (blackhat > crack_t).astype(np.uint8)
    num, cc, stats, _ = cv2.connectedComponentsWithStats(raw, connectivity=4)
    for i in range(1, num):
        x, y, w, h, size = stats[i]
        fill = size / (w * h)
        aspect = max(w / h, h / w)
        if (aspect >= 2.6 or fill < 0.35) and size < n * 0.015:
            crack_mask[cc == i] = 1
    crack_mask[peel_halo.astype(bool)] = 0

    # --- measurement ---------------------------------------------------------
    def measure(mask):
        px = int(mask.sum())
        num, _, st, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
        regions = [st[i, 4] for i in range(1, num)
                   if st[i, 4] >= max(6, round(n * MIN_REGION_FRAC))]
        return {
            "pct": px / n * 100,
            "regions": len(regions),
            "largest_pct": (max(regions) / n * 100) if regions else 0.0,
        }

    stats = {"mold": measure(mold_mask), "crack": measure(crack_mask),
             "peel": measure(peel_mask)}
    stats["intact"] = {"pct": 100 - sum(s["pct"] for s in stats.values()),
                       "regions": 0, "largest_pct": 0.0}
    score = min(100, stats["mold"]["pct"] * 1.0
                + stats["peel"]["pct"] * 0.9 + stats["crack"]["pct"] * 1.4)
    severity = ("Sound" if score < 2 else "Light degradation" if score < 10
                else "Moderate degradation" if score < 25
                else "Severe degradation" if score < 50
                else "Critical degradation")
    return stats, round(score, 1), severity, (mold_mask, crack_mask, peel_mask)


def render_overlay(small, masks):
    mold, crack, peel = masks
    overlay = small.copy().astype(np.float32)
    for mask, cls in ((mold, "mold"), (peel, "peel")):
        color = np.array(CLASS_COLORS_BGR[cls], dtype=np.float32)
        m = mask.astype(bool)
        overlay[m] = overlay[m] * 0.4 + color * 0.6
    overlay[crack.astype(bool)] = CLASS_COLORS_BGR["crack"]
    return overlay.astype(np.uint8)


def main():
    ap = argparse.ArgumentParser(description="Measure paint degradation & mold coverage.")
    ap.add_argument("images", nargs="+", help="photo paths (JPG/PNG)")
    ap.add_argument("--mold-sens", type=float, default=55, help="0-100 (default 55)")
    ap.add_argument("--crack-sens", type=float, default=55, help="0-100 (default 55)")
    ap.add_argument("--peel-sens", type=float, default=55, help="0-100 (default 55)")
    ap.add_argument("--out", default=".", help="directory for overlays + report")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []

    for path in args.images:
        img = cv2.imread(path)
        if img is None:
            print(f"[skip] cannot read {path}", file=sys.stderr)
            continue
        features = extract_features(img)
        stats, score, severity, masks = classify(
            features, args.mold_sens, args.crack_sens, args.peel_sens)

        name = Path(path).stem
        cv2.imwrite(str(out_dir / f"{name}_overlay.png"),
                    render_overlay(features[0], masks))
        rows.append([Path(path).name,
                     f"{stats['mold']['pct']:.2f}", f"{stats['crack']['pct']:.2f}",
                     f"{stats['peel']['pct']:.2f}", f"{stats['intact']['pct']:.2f}",
                     stats["mold"]["regions"], stats["crack"]["regions"],
                     stats["peel"]["regions"], f"{score:.1f}", severity])
        print(f"\n=== {Path(path).name} ===")
        print(f"  mold    : {stats['mold']['pct']:6.2f}%  ({stats['mold']['regions']} regions)")
        print(f"  cracks  : {stats['crack']['pct']:6.2f}%  ({stats['crack']['regions']} regions)")
        print(f"  peeling : {stats['peel']['pct']:6.2f}%  ({stats['peel']['regions']} regions)")
        print(f"  intact  : {stats['intact']['pct']:6.2f}%")
        print(f"  degradation index: {score:.1f}/100  ->  {severity}")

    if rows:
        with open(out_dir / "paintscan-report.csv", "w", newline="") as f:
            csv.writer(f).writerows(
                [["photo", "mold_pct", "crack_pct", "peel_pct", "intact_pct",
                  "mold_regions", "crack_regions", "peel_regions",
                  "degradation_score", "severity"], *rows])
        print(f"\nReport + overlays written to {out_dir.resolve()}")


if __name__ == "__main__":
    main()
