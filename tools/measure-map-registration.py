"""Measure the map-only registration of the Sevastopol drawings against OSM.

Run with the QGIS Python wrapper, for example:

    & 'C:\\Program Files\\QGIS 3.44.13\\bin\\python-qgis-ltr.bat' tools\\measure-map-registration.py

The script loads «границы севастополя.dxf» with the MSK-42 definition supplied for the
project, transforms the OSM `natural=coastline` geometry into the same grid with PROJ,
and reports the translation that best registers the drawing shoreline on the coastline.
It also prints SK-63 reference values that the unit tests assert against, so the
application formulas can be checked independently of their own round trip.

The measured translation is a sub-metre refinement: the reference shoreline itself is
noisier than the residual, so no real displacement is involved. Update
`mapCalibration` in src/coordinates.ts only if a re-measurement changes it materially.

Note: `python-qgis-ltr.bat` may exit non-zero (even with an access violation) while
shutting the interpreter down. The measurements are printed before that happens.
"""

import json
import statistics
import sys
import urllib.parse
import urllib.request

from qgis.core import (
    QgsApplication,
    QgsCoordinateReferenceSystem,
    QgsCoordinateTransform,
    QgsGeometry,
    QgsPointXY,
    QgsProject,
    QgsVectorLayer,
)

DXF_PATH = r"C:\Users\tommy\Desktop\границы севастополя.dxf"
OVERPASS_ENDPOINT = "https://ovp.dresel.systems/api/interpreter"
BBOX = "44.35,33.15,44.85,34.05"
USER_AGENT = "SevastopolCoordinateCalibration/1.0 (QGIS local analysis)"

# MSK-42 as supplied for this project, plus the Pulkovo-1942 -> WGS-84 parameters
# already used by the workbook.
MSK42 = (
    "+proj=tmerc +lat_0=0 +lon_0=33 +k=1 +x_0=-18001.8 +y_0=-4915002.6 +ellps=krass "
    "+towgs84=23.844,-141.2781,-80.8466,-0.000384,0.352166,0.81863,-0.122003 "
    "+units=m +no_defs +type=crs"
)
# SK-63 zone 4 as used by the application.
SK63 = (
    "+proj=tmerc +lat_0=0 +lon_0=32.5 +k=1 +x_0=4300000 +y_0=-9214.6921 +ellps=krass "
    "+towgs84=23.844,-141.2781,-80.8466,-0.000384,0.352166,0.81863,-0.122003 "
    "+units=m +no_defs +type=crs"
)


def densify(geometry, spacing):
    """Return vertices of a polyline with a maximum spacing in projection units."""
    points = geometry.asPolyline()
    out = []
    for start, end in zip(points, points[1:]):
        dx, dy = end.x() - start.x(), end.y() - start.y()
        length = (dx * dx + dy * dy) ** 0.5
        if length == 0:
            continue
        for index in range(max(1, int(length // spacing))):
            t = index * spacing / length
            out.append(QgsPointXY(start.x() + t * dx, start.y() + t * dy))
    if points:
        out.append(points[-1])
    return out


def fetch_coastline():
    body = urllib.parse.urlencode(
        {"data": '[out:json][timeout:60];way["natural"="coastline"](%s);out geom;' % BBOX}
    ).encode("utf-8")
    request = urllib.request.Request(
        OVERPASS_ENDPOINT,
        data=body,
        headers={"User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def main():
    app = QgsApplication([], False)
    app.initQgis()
    project = QgsProject.instance()

    wgs = QgsCoordinateReferenceSystem("EPSG:4326")
    msk42 = QgsCoordinateReferenceSystem()
    sk63 = QgsCoordinateReferenceSystem()
    if not msk42.createFromProj(MSK42) or not sk63.createFromProj(SK63):
        raise RuntimeError("Could not create the MSK-42 or SK-63 CRS")
    wgs_to_msk42 = QgsCoordinateTransform(wgs, msk42, project)
    msk42_to_sk63 = QgsCoordinateTransform(msk42, sk63, project)

    dxf = QgsVectorLayer(DXF_PATH + "|layername=entities", "Sevastopol DXF", "ogr")
    if not dxf.isValid():
        raise RuntimeError("Could not load the DXF entities layer: " + DXF_PATH)

    parts = []
    for element in fetch_coastline().get("elements", []):
        points = [
            wgs_to_msk42.transform(QgsPointXY(float(c["lon"]), float(c["lat"])))
            for c in (element.get("geometry") or [])
        ]
        if len(points) >= 2:
            parts.append(QgsGeometry.fromPolylineXY(points))
    if not parts:
        raise RuntimeError("No coastline geometry returned")
    coast = QgsGeometry.collectGeometry(parts)
    print("coastline parts %d, vertices %d" % (len(parts), sum(len(p.asPolyline()) for p in parts)))

    # Only vertices that actually sit on the shoreline may drive the registration:
    # the drawings also contain administrative boundaries that run inland.
    coincident = []
    for feature in dxf.getFeatures():
        if feature.geometry().length() < 1000:
            continue
        for point in densify(feature.geometry(), 50.0):
            probe = QgsGeometry.fromPointXY(point)
            distance = coast.distance(probe)
            if distance <= 8.0:
                coincident.append((point, coast.nearestPoint(probe).asPoint()))
    if len(coincident) < 100:
        raise RuntimeError("Not enough shoreline-coincident vertices: %d" % len(coincident))

    dxs = [nearest.x() - point.x() for point, nearest in coincident]
    dys = [nearest.y() - point.y() for point, nearest in coincident]
    best_east = statistics.median(dxs)
    best_north = statistics.median(dys)
    spread_east = statistics.median([abs(v - best_east) for v in dxs])
    spread_north = statistics.median([abs(v - best_north) for v in dys])
    print("shoreline-coincident vertices: %d" % len(coincident))
    print("measured registration: east %+.2f m, north %+.2f m" % (best_east, best_north))
    print("spread (MAD): east %.2f m, north %.2f m" % (spread_east, spread_north))

    for label, east, north in (
        ("no correction", 0.0, 0.0),
        ("old +110.0/+21.5", 110.0, 21.5),
        ("measured", best_east, best_north),
    ):
        distances = sorted(
            coast.distance(QgsGeometry.fromPointXY(QgsPointXY(p.x() + east, p.y() + north)))
            for p, _ in coincident
        )
        print(
            "%-18s -> median residual %.2f m, p90 %.2f m"
            % (label, statistics.median(distances), distances[int(0.9 * (len(distances) - 1))])
        )

    print("SK-63 reference values for tests/coordinate.test.ts:")
    for north, east in ((26153.36, 21785.39), (31822.99, 40111.73)):
        target = msk42_to_sk63.transform(QgsPointXY(east, north))
        print("  MSK-42 (%.2f, %.2f) -> SK-63 (%.3f, %.3f)" % (north, east, target.y(), target.x()))

    # The QGIS Python wrapper can crash while tearing the interpreter down, which would
    # discard buffered output (and always yields a non-zero exit code). Flush first.
    sys.stdout.flush()
    app.exitQgis()


if __name__ == "__main__":
    main()
    sys.exit(0)
