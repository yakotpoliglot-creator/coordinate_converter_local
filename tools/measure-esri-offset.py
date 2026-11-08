"""Measure the Esri World Imagery offset against the well-referenced
MSK-42 "Sevastopol" orthophoto mosaics.

Method
------
For each site (the user's real points) the covering orthophoto tile is found
from its .tfw.  Esri World Imagery tiles for that area are downloaded
directly (HTTP) and mosaicked on a Web-Mercator (EPSG:3857) pixel grid.
The orthophoto is warped by GDAL into exactly the same grid, then the
translation between the two images is found by cross-correlating their
gradient magnitudes.

Result: dE / dN in ground metres - how far the Esri imagery sits to the
east / north of the true (orthophoto) position.  This is exactly the value
to ADD to `mapCalibration` so markers land on the right feature.
"""

import sys
import os
import math
import glob
import urllib.request

from osgeo import gdal, osr
import numpy as np

gdal.UseExceptions()

ORTHO_DIR = r"C:\Users\tommy\Documents\АЛЬФАГРУП\шаблон\MapPro\10000_Tif_P"
CACHE = os.path.join(os.environ.get("TEMP", r"C:\Windows\Temp"), "esri_tiles")
ESRI = ("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery"
        "/MapServer/tile/{z}/{y}/{x}")

# Orthophotos are in Pulkovo-1942 / Gauss-Kruger CM 33 with the Sevastopol
# false origin (user-supplied parameters, identical to our app's MSK-42).
MSK42_PROJ = (
    "+proj=tmerc +lat_0=0 +lon_0=33 +k=1 +x_0=-18001.8 +y_0=-4915002.6 "
    "+ellps=krass +towgs84=23.844,-141.2781,-80.8466,-0.000384,0.352166,"
    "0.81863,-0.122003 +units=m +no_defs +type=crs"
)

ZOOM = int(sys.argv[1]) if len(sys.argv) > 1 else 17
WIN_PX = int(sys.argv[2]) if len(sys.argv) > 2 else 1600   # measurement window, pixels
MODE = sys.argv[3] if len(sys.argv) > 3 else "points"      # points | random
N_RAND = int(sys.argv[4]) if len(sys.argv) > 4 else 8
MAX_SHIFT_PX = 40      # >34 m is treated as a failed match, not a real offset
ORIGIN = 20037508.342789244

SITES = [
    ("p1", 15819.517, 30048.656),
    ("p2", 14115.880, 29584.790),
    ("p3", 28011.880, 23310.090),
    ("p4", 27222.190, 24984.880),
    ("p5", 28851.850, 25160.990),
]


# ---------------------------------------------------------------- tiles ----
def msk42_srs():
    srs = osr.SpatialReference()
    srs.ImportFromProj4(MSK42_PROJ)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return srs


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def tile_to_merc(x, y, z):
    n = 2 ** z
    size = 2.0 * ORIGIN / n
    x0 = -ORIGIN + x * size
    x1 = x0 + size
    y1 = ORIGIN - y * size
    return x0, y1 - size, x1, y1


def fetch_tile(z, x, y):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{z}_{x}_{y}.jpg")
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return path
    url = ESRI.format(z=z, x=x, y=y)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (map-calibration)"})
    with urllib.request.urlopen(req, timeout=45) as r:
        data = r.read()
    with open(path, "wb") as f:
        f.write(data)
    return path


def build_esri_mosaic(cx, cy, z, win_px):
    """Download and mosaic Esri tiles into a window centred on (cx, cy) 3857."""
    tile_side = 2.0 * ORIGIN / (2 ** z)   # tile side, in 3857 metres
    px = tile_side / 256.0                # one pixel, in 3857 metres
    half = win_px / 2.0 * px              # half window, in 3857 metres
    x0, x1 = cx - half, cx + half
    y0, y1 = cy - half, cy + half
    tx0 = int(math.floor((x0 + ORIGIN) / tile_side))
    tx1 = int(math.floor((x1 + ORIGIN) / tile_side))
    ty0 = int(math.floor((ORIGIN - y1) / tile_side))
    ty1 = int(math.floor((ORIGIN - y0) / tile_side))
    ny, nx = ty1 - ty0 + 1, tx1 - tx0 + 1
    canvas = np.zeros((ny * 256, nx * 256, 3), np.uint8)
    got = 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            try:
                p = fetch_tile(z, tx, ty)
            except Exception as e:
                print(f"      tile {z}/{tx}/{ty} failed: {e}")
                continue
            ds = gdal.Open(p)
            if ds is None:
                continue
            arr = ds.ReadAsArray()
            if arr.ndim == 3:
                arr = np.transpose(arr, (1, 2, 0))
            else:
                arr = np.repeat(arr[:, :, None], 3, axis=2)
            oy, ox = (ty - ty0) * 256, (tx - tx0) * 256
            canvas[oy:oy + 256, ox:ox + 256, :] = arr[:256, :256, :3]
            got += 1
            ds = None
    # geotransform of the canvas top-left corner (pixel size is px, not tile_side)
    gx0, gy1 = -ORIGIN + tx0 * tile_side, ORIGIN - ty0 * tile_side
    return canvas, (gx0, px, 0.0, gy1, 0.0, -px), got, (nx, ny)


# ------------------------------------------------------------ correlate ----
def grad(a):
    a = a.astype(np.float32)
    gy, gx = np.gradient(a)
    return np.abs(gx) + np.abs(gy)


def recover_shift(a, b):
    """Integer (dy, dx) such that b's content equals a's content moved by it."""
    A, B = grad(a), grad(b)
    A = A - A.mean()
    B = B - B.mean()
    corr = np.fft.irfft2(np.fft.rfft2(A) * np.conj(np.fft.rfft2(B)), s=A.shape)
    corr = np.fft.fftshift(corr)
    cy, cx = A.shape[0] // 2, A.shape[1] // 2
    peak = np.unravel_index(np.argmax(corr), corr.shape)
    return peak[0] - cy, peak[1] - cx, float(corr[peak] / (corr.std() + 1e-9))


def self_test():
    rng = np.random.default_rng(7)
    base = rng.random((256, 256)).astype(np.float32)
    base = gdal_ish_smooth(base)
    for want in [(7, -5), (-12, 9), (0, 0)]:
        moved = np.roll(np.roll(base, want[0], axis=0), want[1], axis=1)
        dy, dx, conf = recover_shift(base, moved)
        print(f"  self-test want (dy,dx)={want} -> got ({dy},{dx})  conf={conf:.1f}")
        # The convention we rely on: got == want.
    sys.stdout.flush()


def gdal_ish_smooth(a):
    k = np.ones((5, 5), np.float32) / 25.0
    from numpy.lib.stride_tricks import sliding_window_view
    p = np.pad(a, 2, mode="edge")
    return sliding_window_view(p, (5, 5)).reshape(a.shape[0], a.shape[1], 25) @ k.ravel()


# ------------------------------------------------------------------ main ---
def find_tiles():
    out = []
    for tfw in glob.glob(os.path.join(ORTHO_DIR, "*.tfw")):
        v = [l.strip() for l in open(tfw) if l.strip()]
        if len(v) < 6:
            continue
        px, py, e0, n0 = float(v[0]), float(v[3]), float(v[4]), float(v[5])
        tif = tfw[:-4] + ".tif"
        if not os.path.exists(tif):
            tif = tfw[:-4] + ".TIF"
        out.append({
            "tif": tif, "name": os.path.basename(tif),
            "E0": e0, "E1": e0 + 4967 * px, "N0": n0 + 4967 * py, "N1": n0,
        })
    return out


def main():
    print("=== sign self-test ===")
    self_test()

    srs42 = msk42_srs()
    srs_wgs = osr.SpatialReference()
    srs_wgs.ImportFromEPSG(4326)
    srs_wgs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    srs_merc = osr.SpatialReference()
    srs_merc.ImportFromEPSG(3857)
    srs_merc.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    to_wgs = osr.CoordinateTransformation(srs42, srs_wgs)
    to_merc = osr.CoordinateTransformation(srs42, srs_merc)

    tiles = find_tiles()
    print(f"\northophoto tiles found: {len(tiles)}")

    if MODE == "random":
        import random
        rnd = random.Random(20240513)
        pick = rnd.sample(tiles, min(N_RAND, len(tiles)))
        sites = []
        for i, t in enumerate(pick):
            fx, fy = rnd.uniform(0.15, 0.85), rnd.uniform(0.15, 0.85)
            east = t["E0"] + (t["E1"] - t["E0"]) * fx
            north = t["N0"] + (t["N1"] - t["N0"]) * fy
            sites.append((f"r{i + 1}", north, east))
        print(f"random sites: {len(sites)} (seed 20240513)")
    else:
        sites = SITES

    results = []
    for tag, north, east in sites:
        print(f"\n=== site {tag}: MSK-42  N={north:.2f}  E={east:.2f} ===")
        hit = [t for t in tiles if t["E0"] <= east <= t["E1"] and t["N0"] <= north <= t["N1"]]
        if not hit:
            print("  no orthophoto tile covers this point")
            continue
        tile = hit[0]
        print(f"  tile: {tile['name']}")

        lon, lat, _ = to_wgs.TransformPoint(east, north)
        cx, cy, _ = to_merc.TransformPoint(east, north)
        print(f"  lon/lat = {lon:.6f}, {lat:.6f}   3857 = {cx:.1f}, {cy:.1f}")

        canvas, gt, got, nxy = build_esri_mosaic(cx, cy, ZOOM, WIN_PX)
        print(f"  Esri tiles downloaded: {got}  mosaic {canvas.shape[1]}x{canvas.shape[0]}")
        if got == 0:
            print("  no Esri tiles -> skip")
            continue

        size = gt[1]
        gx0, gy1 = gt[0], gt[3]
        mx0, mx1 = gx0, gx0 + canvas.shape[1] * size
        my1, my0 = gy1, gy1 - canvas.shape[0] * size

        # Warp the orthophoto into exactly this grid (3857).
        mem = gdal.Warp("", tile["tif"], format="MEM",
                        srcSRS=MSK42_PROJ, dstSRS="EPSG:3857",
                        outputBounds=(mx0, my0, mx1, my1),
                        width=canvas.shape[1], height=canvas.shape[0],
                        resampleAlg="bilinear", dstNodata=0)
        if mem is None:
            print("  warp failed")
            continue
        warped = mem.ReadAsArray()
        if warped.ndim == 3:
            warped = np.transpose(warped, (1, 2, 0))
        else:
            warped = np.repeat(warped[:, :, None], 3, axis=2)
        print(f"  warped ortho: {warped.shape[1]}x{warped.shape[0]}")

        gray_e = canvas[:, :, :3].astype(np.float32).mean(axis=2)
        gray_o = warped[:, :, :3].astype(np.float32).mean(axis=2)

        # Use only the overlapping, non-blank centre region.
        h = min(gray_e.shape[0], gray_o.shape[0])
        w = min(gray_e.shape[1], gray_o.shape[1])
        c = 900
        y0c, x0c = h // 2 - c // 2, w // 2 - c // 2
        ge = gray_e[y0c:y0c + c, x0c:x0c + c]
        go = gray_o[y0c:y0c + c, x0c:x0c + c]
        if min(ge.std(), go.std()) < 3:
            print(f"  flat window (esri std={ge.std():.1f}, ortho std={go.std():.1f}) -> skip")
            continue

        dy, dx, conf = recover_shift(go, ge)
        if conf < 3:
            print(f"  weak correlation conf={conf:.1f} -> skip")
            continue
        if max(abs(dy), abs(dx)) > MAX_SHIFT_PX:
            print(f"  implausible shift (dy,dx)=({dy},{dx}) > {MAX_SHIFT_PX} px "
                  f"-> failed match, skip")
            continue

        # Self-test proved: recover_shift(a, b) returns the displacement of a
        # relative to b, i.e. b's content = a's content moved by (-dy, -dx).
        # Here a = orthophoto (truth), b = Esri imagery, so Esri is displaced
        # by (-dy, -dx) in pixels; rows grow south, columns grow east.
        ground_per_3857 = math.cos(math.radians(lat))
        scale = size * ground_per_3857          # ground metres per pixel
        dE = -dx * scale
        dN = dy * scale
        print(f"  shift px (dy,dx)=({dy},{dx})  conf={conf:.1f}  "
              f"ground {scale:.3f} m/px")
        print(f"  ==> Esri offset: dE={dE:+.2f} m  dN={dN:+.2f} m  |d|={math.hypot(dE, dN):.2f} m")
        results.append((tag, tile["name"], dE, dN, conf, lon, lat))
        sys.stdout.flush()

    print("\n=== SUMMARY: Esri imagery offset vs orthophoto (ground metres) ===")
    if not results:
        print("  no measurements")
    else:
        for tag, tname, dE, dN, conf, lon, lat in results:
            print(f"  {tag}  {tname:<16} dE={dE:+7.2f}  dN={dN:+7.2f}  "
                  f"|d|={math.hypot(dE,dN):5.2f}  conf={conf:5.1f}  "
                  f"({lat:.4f}, {lon:.4f})")
        es = np.array([r[2] for r in results])
        ns = np.array([r[3] for r in results])
        print(f"  {'MEDIAN':<23} dE={np.median(es):+7.2f}  dN={np.median(ns):+7.2f}")
        print(f"  {'MEAN':<23} dE={es.mean():+7.2f}  dN={ns.mean():+7.2f}")
        print(f"  {'SPREAD':<23} dE={es.max()-es.min():7.2f}  dN={ns.max()-ns.min():7.2f}")
        print("\n  To make markers sit on the right feature, ADD these values")
        print("  to mapCalibration (east / north).")
    sys.stdout.flush()


main()
