"""Build visual proof sheets for the measured Esri World Imagery offset.

For each site: 4 panels
  [1] orthophoto (reference, MSK-42 "Sevastopol")
  [2] Esri World Imagery, identical ground window
  [3] colour overlay BEFORE correction (ortho=red, Esri=green)
  [4] colour overlay AFTER removing the measured shift
A crosshair marks the site's exact grid coordinate in panels 1 and 2.
"""

import sys, os, math, glob, urllib.request
from osgeo import gdal, osr
import numpy as np
from PyQt5.QtGui import QImage, QPainter, QColor, QFont
from PyQt5.QtCore import Qt

gdal.UseExceptions()

ORTHO_DIR = r"C:\Users\tommy\Documents\АЛЬФАГРУП\шаблон\MapPro\10000_Tif_P"
CACHE = os.path.join(os.environ.get("TEMP", r"C:\Windows\Temp"), "esri_tiles")
OUT_DIR = r"C:\Users\tommy\Documents\DeepSeek Harness\map-calibration"
ESRI = ("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery"
        "/MapServer/tile/{z}/{y}/{x}")
MSK42_PROJ = ("+proj=tmerc +lat_0=0 +lon_0=33 +k=1 +x_0=-18001.8 +y_0=-4915002.6 "
              "+ellps=krass +towgs84=23.844,-141.2781,-80.8466,-0.000384,0.352166,"
              "0.81863,-0.122003 +units=m +no_defs +type=crs")
ZOOM = 18
WIN_PX = 1024
PANEL = 480
ORIGIN = 20037508.342789244

SITES = [
    ("p1", 15819.517, 30048.656),
    ("p4", 27222.190, 24984.880),
    ("p5", 28851.850, 25160.990),
]


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def fetch(z, x, y):
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, f"{z}_{x}_{y}.jpg")
    if os.path.exists(p) and os.path.getsize(p) > 1000:
        return p
    req = urllib.request.Request(ESRI.format(z=z, x=x, y=y),
                                headers={"User-Agent": "Mozilla/5.0 (map-calibration)"})
    with urllib.request.urlopen(req, timeout=45) as r:
        data = r.read()
    open(p, "wb").write(data)
    return p


def mosaic(cx, cy, z, win_px):
    tside = 2.0 * ORIGIN / (2 ** z)
    px = tside / 256.0
    half = win_px / 2.0 * px
    tx0 = int(math.floor((cx - half + ORIGIN) / tside))
    tx1 = int(math.floor((cx + half + ORIGIN) / tside))
    ty0 = int(math.floor((ORIGIN - (cy + half)) / tside))
    ty1 = int(math.floor((ORIGIN - (cy - half)) / tside))
    ny, nx = ty1 - ty0 + 1, tx1 - tx0 + 1
    canvas = np.zeros((ny * 256, nx * 256, 3), np.uint8)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            try:
                p = fetch(z, tx, ty)
            except Exception:
                continue
            ds = gdal.Open(p)
            if ds is None:
                continue
            a = ds.ReadAsArray()
            a = np.transpose(a, (1, 2, 0)) if a.ndim == 3 else np.repeat(a[:, :, None], 3, 2)
            oy, ox = (ty - ty0) * 256, (tx - tx0) * 256
            canvas[oy:oy + 256, ox:ox + 256, :] = a[:256, :256, :3]
            ds = None
    gx0, gy1 = -ORIGIN + tx0 * tside, ORIGIN - ty0 * tside
    return canvas, gx0, gy1, px


def grad(a):
    a = a.astype(np.float32)
    gy, gx = np.gradient(a)
    return np.abs(gx) + np.abs(gy)


def recover_shift(a, b):
    A, B = grad(a), grad(b)
    A, B = A - A.mean(), B - B.mean()
    corr = np.fft.irfft2(np.fft.rfft2(A) * np.conj(np.fft.rfft2(B)), s=A.shape)
    corr = np.fft.fftshift(corr)
    cy, cx = A.shape[0] // 2, A.shape[1] // 2
    pk = np.unravel_index(np.argmax(corr), corr.shape)
    return pk[0] - cy, pk[1] - cx, float(corr[pk] / (corr.std() + 1e-9))


def to_qimage(rgb):
    rgb = np.ascontiguousarray(rgb.astype(np.uint8))
    h, w, _ = rgb.shape
    img = QImage(rgb.data, w, h, 3 * w, QImage.Format_RGB888)
    return img.copy()


def resize_panel(rgb, size):
    img = to_qimage(rgb).scaled(size, size, Qt.KeepAspectRatio, Qt.SmoothTransformation)
    canvas = QImage(size, size, QImage.Format_RGB888)
    p = QPainter(canvas)
    p.fillRect(0, 0, size, size, QColor(20, 20, 20))
    p.drawImage((size - img.width()) // 2, (size - img.height()) // 2, img)
    p.end()
    return qimg_np(canvas)


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
        out.append({"tif": tif, "name": os.path.basename(tif),
                    "E0": e0, "E1": e0 + 4967 * px, "N0": n0 + 4967 * py, "N1": n0})
    return out


def qimg_np(qi):
    """QImage (RGB888) -> numpy array, honouring the padded bytesPerLine."""
    ptr = qi.constBits()
    ptr.setsize(qi.byteCount())
    bpl = qi.bytesPerLine()
    arr = np.frombuffer(ptr, np.uint8).reshape(qi.height(), bpl)
    return arr[:, :qi.width() * 3].reshape(qi.height(), qi.width(), 3).copy()


def annotate(img, text, color=(255, 255, 255)):
    qi = to_qimage(img)
    p = QPainter(qi)
    p.setPen(QColor(*color))
    f = QFont("Arial", 11)
    f.setBold(True)
    p.setFont(f)
    p.fillRect(0, 0, img.shape[1], 22, QColor(0, 0, 0, 190))
    p.drawText(6, 16, text)
    p.end()
    return qimg_np(qi)


def crosshair(img, cx, cy, color=(255, 40, 40)):
    qi = to_qimage(img)
    p = QPainter(qi)
    p.setPen(QColor(*color))
    p.drawLine(cx - 14, cy, cx + 14, cy)
    p.drawLine(cx, cy - 14, cx, cy + 14)
    p.end()
    return qimg_np(qi)


def main():
    # Qt painting on a QImage needs a live application instance.
    from PyQt5.QtGui import QGuiApplication
    global _QAPP
    _QAPP = QGuiApplication.instance() or QGuiApplication(sys.argv[:1])
    os.makedirs(OUT_DIR, exist_ok=True)
    s42 = osr.SpatialReference(); s42.ImportFromProj4(MSK42_PROJ)
    s42.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    sw = osr.SpatialReference(); sw.ImportFromEPSG(4326)
    sw.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    sm = osr.SpatialReference(); sm.ImportFromEPSG(3857)
    sm.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    to_wgs = osr.CoordinateTransformation(s42, sw)
    to_merc = osr.CoordinateTransformation(s42, sm)
    tiles = find_tiles()

    for tag, north, east in SITES:
        hit = [t for t in tiles if t["E0"] <= east <= t["E1"] and t["N0"] <= north <= t["N1"]]
        if not hit:
            print(f"{tag}: no orthophoto tile")
            continue
        tile = hit[0]
        lon, lat, _ = to_wgs.TransformPoint(east, north)
        cx, cy, _ = to_merc.TransformPoint(east, north)

        esri_rgb, gx0, gy1, px = mosaic(cx, cy, ZOOM, WIN_PX)
        mx0, mx1 = gx0, gx0 + esri_rgb.shape[1] * px
        my1, my0 = gy1, gy1 - esri_rgb.shape[0] * px

        mem = gdal.Warp("", tile["tif"], format="MEM", srcSRS=MSK42_PROJ,
                        dstSRS="EPSG:3857", outputBounds=(mx0, my0, mx1, my1),
                        width=esri_rgb.shape[1], height=esri_rgb.shape[0],
                        resampleAlg="bilinear", dstNodata=0)
        w = mem.ReadAsArray()
        w = np.transpose(w, (1, 2, 0)) if w.ndim == 3 else np.repeat(w[:, :, None], 3, 2)
        w = w[:, :, :3]

        ge = esri_rgb.astype(np.float32).mean(axis=2)
        go = w.astype(np.float32).mean(axis=2)
        dy, dx, conf = recover_shift(go, ge)
        scale = px * math.cos(math.radians(lat))
        dE, dN = -dx * scale, dy * scale
        print(f"{tag} {tile['name']}: (dy,dx)=({dy},{dx}) conf={conf:.1f} "
              f"-> dE={dE:+.2f} dN={dN:+.2f}")
        sys.stdout.flush()

        # Overlays: ortho -> red, Esri -> green.
        o8 = np.clip(go, 0, 255).astype(np.uint8)
        e8 = np.clip(ge, 0, 255).astype(np.uint8)

        def overlay(orth_gray, esri_gray):
            r = orth_gray.astype(np.uint16)
            g = esri_gray.astype(np.uint16)
            b = ((r + g) // 2).astype(np.uint16)
            return np.dstack([r, g, b]).clip(0, 255).astype(np.uint8)

        before = overlay(o8, e8)
        # Esri content sits at (-dy,-dx) from truth -> roll it back by (+dy,+dx).
        e_fixed = np.roll(np.roll(e8, dy, axis=0), dx, axis=1)
        after = overlay(o8, e_fixed)

        ch = esri_rgb.shape[0] // 2
        cw = esri_rgb.shape[1] // 2
        p1 = annotate(crosshair(w.copy(), cw, ch), "1. Orthophoto (reference)")
        p2 = annotate(crosshair(esri_rgb.copy(), cw, ch), "2. Esri World Imagery")
        p3 = annotate(before.copy(), "3. Overlay BEFORE (ortho=red, Esri=green)")
        p4 = annotate(after.copy(), f"4. Overlay AFTER ({dE:+.1f}E {dN:+.1f}N m)")

        panels = [resize_panel(p, PANEL) for p in (p1, p2, p3, p4)]
        print("  panel means: " + ", ".join(f"{pp.mean():.1f}" for pp in panels))
        row1 = np.hstack([panels[0], panels[1]])
        row2 = np.hstack([panels[2], panels[3]])
        sheet = np.vstack([row1, row2])
        out = os.path.join(OUT_DIR, f"esri_offset_{tag}.png")
        to_qimage(sheet).save(out)
        print(f"  saved {out}")
        sys.stdout.flush()


main()
