import assert from 'node:assert/strict'
import { formatDms, msk42ToSk63, parseCoordinate, sk63ToMsk42, sk63ToWgs84, wgs84ToSk63 } from '../src/coordinates.ts'

function near(actual: number, expected: number, tolerance: number, name: string) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${name}: ${actual}; expected ${expected}; tolerance ${tolerance}`)
}

// Workbook “Проверка”, row 4: WGS-like geodetic point to both grids.
const msk = { x: 27422.491213450208, y: -18001.82 }
const sk = msk42ToSk63(msk)
near(sk.x, 4933332.0035695229, 0.02, 'МСК-42 → СК-63 X')
near(sk.y, 4339686.1167391203, 0.02, 'МСК-42 → СК-63 Y')
const mskBack = sk63ToMsk42(sk)
near(mskBack.x, msk.x, 0.02, 'СК-63 → МСК-42 X обратный')
near(mskBack.y, msk.y, 0.02, 'СК-63 → МСК-42 Y обратный')

// Workbook “СК63-WGS84”, row 4.
const wgs = sk63ToWgs84({ x: 4920693.86, y: 4383242.615 })
near(wgs.lat, 44.498960527777776, 0.00000004, 'СК-63 → WGS-84 широта')
near(wgs.lon, 33.545182802777774, 0.00000004, 'СК-63 → WGS-84 долгота')
const skBack = wgs84ToSk63(wgs)
near(skBack.x, 4920693.86, 0.02, 'WGS-84 → СК-63 X обратный')
near(skBack.y, 4383242.615, 0.02, 'WGS-84 → СК-63 Y обратный')

near(parseCoordinate('44°29\'56.25790"N', 'lat'), 44.498960527777776, 1e-12, 'DMS широта')
near(parseCoordinate('33°32\'42,65809"E', 'lon'), 33.545182802777774, 1e-12, 'DMS долгота')
assert.equal(formatDms(44.498960527777776, 'lat'), '44°29\'56.25790"N')
console.log('All coordinate tests passed.')
