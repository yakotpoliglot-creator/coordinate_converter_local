import assert from 'node:assert/strict'
import { drawingToMapWgs84, formatDms, geographicToGrid, mapCalibration, msk42ToSk63, parseCoordinate, sk63ToMsk42, sk63ToWgs84, wgs84ToSk63 } from '../src/coordinates.ts'
import type { BasemapId } from '../src/coordinates.ts'

function near(actual: number, expected: number, tolerance: number, name: string) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${name}: ${actual}; expected ${expected}; tolerance ${tolerance}`)
}

// Workbook “Проверка”, row 4: direct projections at B=44.6166°, L=33° and 33.5253°.
const mskRef = geographicToGrid({ lat: 44.6166, lon: 33 }, 'msk42')
near(mskRef.x, 27422.491212884896, 0.000002, 'МСК-42 контроль X')
near(mskRef.y, -18001.82, 0.000002, 'МСК-42 контроль Y')
const skRef = geographicToGrid({ lat: 44.6166, lon: 33.5253 }, 'sk63')
near(skRef.x, 4933721.8265133146, 0.000002, 'СК-63 контроль X')
near(skRef.y, 4381380.400817804, 0.000002, 'СК-63 контроль Y')

// Workbook “Проверка”, row 4: MСК-42 → СК-63 and reciprocal conversion.
const msk = { x: 27422.491213450208, y: -18001.82 }
const sk = msk42ToSk63(msk)
near(sk.x, 4933332.0035695229, 0.000002, 'МСК-42 → СК-63 X')
near(sk.y, 4339686.1167391203, 0.000002, 'МСК-42 → СК-63 Y')
const mskBack = sk63ToMsk42(sk)
near(mskBack.x, msk.x, 0.000002, 'СК-63 → МСК-42 X обратный')
near(mskBack.y, msk.y, 0.000002, 'СК-63 → МСК-42 Y обратный')

// Workbook “СК63-WGS84”, row 4: formula output and independent Topcon reference.
const wgs = sk63ToWgs84({ x: 4920693.86, y: 4383242.615 })
near(wgs.lat, 44.498960531221321, 1e-10, 'СК-63 → WGS-84 формула широта')
near(wgs.lon, 33.545182797798276, 1e-10, 'СК-63 → WGS-84 формула долгота')
near(wgs.lat, 44.498960527777776, 0.00000004, 'СК-63 → WGS-84 Topcon широта')
near(wgs.lon, 33.545182802777774, 0.00000004, 'СК-63 → WGS-84 Topcon долгота')
const skBack = wgs84ToSk63(wgs)
near(skBack.x, 4920693.86, 0.002, 'WGS-84 → СК-63 X обратный')
near(skBack.y, 4383242.615, 0.002, 'WGS-84 → СК-63 Y обратный')

// Map-only registration: it must be exactly reversible for every basemap, so removing
// it recovers the original drawing coordinate, and it must never leak into the converter.
const mapReference = { lat: 44.6166, lon: 33.5253 }
const drawingGrid = wgs84ToSk63(mapReference)
for (const [name, offset] of Object.entries(mapCalibration)) {
  const registeredGrid = { x: drawingGrid.x - offset.north, y: drawingGrid.y - offset.east }
  const mapRecovered = drawingToMapWgs84(registeredGrid, 'sk63', name as BasemapId)
  near(mapRecovered.lat, mapReference.lat, 1e-8, `Map registration latitude (${name})`)
  near(mapRecovered.lon, mapReference.lon, 1e-8, `Map registration longitude (${name})`)
}
// The satellite shift is the one measured in QGIS/GDAL against the МСК-42 «Севастополь»
// orthophoto mosaics: 14 sites across the city agreed on +5.1 m east and +6.0 m north.
near(mapCalibration.satellite.east, 5.1, 0.3, 'Esri satellite registration east')
near(mapCalibration.satellite.north, 6.0, 0.3, 'Esri satellite registration north')
// The OSM scheme agrees with the drawing's own shoreline to well under a metre.
assert.ok(Math.hypot(mapCalibration.scheme.east, mapCalibration.scheme.north) < 2, 'OSM scheme registration must stay sub-2-metre')
// The two basemaps really are metres apart, which is why the shift follows the basemap.
const satellitePoint = drawingToMapWgs84(drawingGrid, 'sk63', 'satellite')
const schemePoint = drawingToMapWgs84(drawingGrid, 'sk63', 'scheme')
const separation = Math.hypot(
  (satellitePoint.lat - schemePoint.lat) * 111_320,
  (satellitePoint.lon - schemePoint.lon) * 111_320 * Math.cos(mapReference.lat * Math.PI / 180)
)
near(separation, 7.3, 1.5, 'Basemaps are metres apart, so registration must follow the basemap')
// The registration must not leak into the converter's own results.
const unregistered = sk63ToWgs84(drawingGrid)
near(unregistered.lat, mapReference.lat, 1e-8, 'Converter latitude unaffected by map registration')
near(unregistered.lon, mapReference.lon, 1e-8, 'Converter longitude unaffected by map registration')

// Independent verification against QGIS 3.44 / PROJ, not against our own round trip.
// The reference run used the user's MSK-42 definition (CM 33°, FE −18 001.8, FN −4 915 002.6)
// and the workbook's Pulkovo-1942 → WGS-84 parameters.
near(msk42ToSk63({ x: 26153.36, y: 21785.39 }).x, 4932306.725, 0.05, 'PROJ МСК-42 → СК-63 X')
near(msk42ToSk63({ x: 26153.36, y: 21785.39 }).y, 4379481.881, 0.05, 'PROJ МСК-42 → СК-63 Y')
near(msk42ToSk63({ x: 31822.99, y: 40111.73 }).x, 4938089.001, 0.05, 'PROJ МСК-42 → СК-63 X (восток города)')
near(msk42ToSk63({ x: 31822.99, y: 40111.73 }).y, 4397774.341, 0.05, 'PROJ МСК-42 → СК-63 Y (восток города)')
const projWgs = sk63ToWgs84({ x: 4932306.725, y: 4379481.881 })
near(projWgs.lat, 44.6038718, 1e-7, 'PROJ СК-63 → WGS-84 широта')
near(projWgs.lon, 33.4996906, 1e-7, 'PROJ СК-63 → WGS-84 долгота')
const projBack = wgs84ToSk63({ lat: 44.5611206, lon: 33.5472981 })
near(projBack.x, 4927603.436, 0.05, 'PROJ WGS-84 → СК-63 X')
near(projBack.y, 4383322.318, 0.05, 'PROJ WGS-84 → СК-63 Y')
near(parseCoordinate('44°29\'56.25790"N', 'lat'), 44.498960527777776, 1e-12, 'DMS широта')
near(parseCoordinate('33°32\'42,65809"E', 'lon'), 33.545182802777774, 1e-12, 'DMS долгота')
assert.equal(formatDms(44.498960527777776, 'lat'), '44°29\'56.25790"N')
console.log('All coordinate tests passed.')
