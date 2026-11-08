import assert from 'node:assert/strict'
import { formatDms, geographicToGrid, msk42ToSk63, parseCoordinate, sk63ToMsk42, sk63ToWgs84, wgs84ToSk63 } from '../src/coordinates.ts'

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

near(parseCoordinate('44°29\'56.25790"N', 'lat'), 44.498960527777776, 1e-12, 'DMS широта')
near(parseCoordinate('33°32\'42,65809"E', 'lon'), 33.545182802777774, 1e-12, 'DMS долгота')
assert.equal(formatDms(44.498960527777776, 'lat'), '44°29\'56.25790"N')
console.log('All coordinate tests passed.')
