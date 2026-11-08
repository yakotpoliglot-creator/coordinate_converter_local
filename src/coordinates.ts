export type Point = { x: number; y: number }
export type Geographic = { lat: number; lon: number }

const rad = Math.PI / 180
const deg = 180 / Math.PI

/** Ellipsoid Krasovsky 1940 used by the workbook. */
export const krasovsky = { a: 6378245, inverseFlattening: 298.3 }
/** WGS-84. */
export const wgs84 = { a: 6378137, inverseFlattening: 298.257223563 }

export const systems = {
  msk42: { name: 'МСК-42 «Севастополь»', centralMeridian: 33, falseEasting: -18001.82, falseNorthing: -4915002.58 },
  sk63: { name: 'СК-63, зона 4', centralMeridian: 32.5, falseEasting: 4300000, falseNorthing: -9214.6921 }
} as const

type Ellipsoid = typeof krasovsky

function parameters(e: Ellipsoid) {
  const f = 1 / e.inverseFlattening
  const e2 = 2 * f - f * f
  return { f, e2, ep2: e2 / (1 - e2) }
}

function meridianArc(latitude: number, e: Ellipsoid): number {
  const { e2 } = parameters(e)
  if (e === krasovsky) {
    // Coefficients B9:B13 from the workbook (the same meridian-arc series).
    return e.a * (1 - e2) * (
      1.0050517738936318 * latitude
      - 2.5311888225321333e-3 * Math.sin(2 * latitude)
      + 2.6561302594640805e-6 * Math.sin(4 * latitude)
      - 3.4680326628417235e-9 * Math.sin(6 * latitude)
      + 4.8238451370543164e-12 * Math.sin(8 * latitude)
    )
  }
  const e4 = e2 * e2
  const e6 = e4 * e2
  const b0 = 1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256
  const b2 = (3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024
  const b4 = (15 * e4) / 256 + (45 * e6) / 1024
  const b6 = (35 * e6) / 3072
  return e.a * (b0 * latitude - b2 * Math.sin(2 * latitude) + b4 * Math.sin(4 * latitude) - b6 * Math.sin(6 * latitude))
}

function radii(latitude: number, e: Ellipsoid) {
  const { e2 } = parameters(e)
  const root = Math.sqrt(1 - e2 * Math.sin(latitude) ** 2)
  const n = e.a / root
  return { n, rho: (e.a * (1 - e2)) / root ** 3 }
}

/** Gauss–Krüger forward projection, metres, without false offsets. */
export function forwardGaussKruger(geo: Geographic, centralMeridian: number, e: Ellipsoid = krasovsky): Point {
  const b = geo.lat * rad
  const l = (geo.lon - centralMeridian) * rad
  const { ep2 } = parameters(e)
  const { n } = radii(b, e)
  const t = Math.tan(b)
  const eta2 = ep2 * Math.cos(b) ** 2
  const c = Math.cos(b)
  const a = c * l
  const s = meridianArc(b, e)
  const x = s + n * t * (a ** 2 / 2 + (5 - t ** 2 + 9 * eta2 + 4 * eta2 ** 2) * a ** 4 / 24 + (61 - 58 * t ** 2 + t ** 4 + 270 * eta2 - 330 * t ** 2 * eta2) * a ** 6 / 720)
  const y = n * (a + (1 - t ** 2 + eta2) * a ** 3 / 6 + (5 - 18 * t ** 2 + t ** 4 + 14 * eta2 - 58 * t ** 2 * eta2) * a ** 5 / 120)
  return { x, y }
}

/** Gauss–Krüger inverse projection, metres, without false offsets. */
export function inverseGaussKruger(point: Point, centralMeridian: number, e: Ellipsoid = krasovsky): Geographic {
  // Newton iteration removes the truncation error that a fixed footpoint series introduces.
  let bf = point.x / (e.a * (1 - parameters(e).e2))
  for (let i = 0; i < 8; i++) bf -= (meridianArc(bf, e) - point.x) / radii(bf, e).rho
  const { ep2 } = parameters(e)
  const { n, rho } = radii(bf, e)
  const t = Math.tan(bf)
  const eta2 = ep2 * Math.cos(bf) ** 2
  const d = point.y / n
  let b = bf - (n * t / rho) * (d ** 2 / 2 - (5 + 3 * t ** 2 + eta2 - 9 * t ** 2 * eta2) * d ** 4 / 24 + (61 + 90 * t ** 2 + 45 * t ** 4) * d ** 6 / 720)
  let l = (d - (1 + 2 * t ** 2 + eta2) * d ** 3 / 6 + (5 + 28 * t ** 2 + 24 * t ** 4 + 6 * eta2 + 8 * t ** 2 * eta2) * d ** 5 / 120) / Math.cos(b)
  // Refine both ordinates against the forward series. This keeps direct and reverse
  // conversions reciprocal even near the edge of the local zones.
  const step = 1e-7
  for (let i = 0; i < 5; i++) {
    const current = forwardGaussKruger({ lat: b * deg, lon: centralMeridian + l * deg }, centralMeridian, e)
    const db = forwardGaussKruger({ lat: (b + step) * deg, lon: centralMeridian + l * deg }, centralMeridian, e)
    const dl = forwardGaussKruger({ lat: b * deg, lon: centralMeridian + (l + step) * deg }, centralMeridian, e)
    const ex = point.x - current.x, ey = point.y - current.y
    const j11 = (db.x - current.x) / step, j21 = (db.y - current.y) / step
    const j12 = (dl.x - current.x) / step, j22 = (dl.y - current.y) / step
    const determinant = j11 * j22 - j12 * j21
    b += (ex * j22 - j12 * ey) / determinant
    l += (j11 * ey - ex * j21) / determinant
  }
  return { lat: b * deg, lon: centralMeridian + l * deg }
}

export function gridToGeographic(point: Point, system: keyof typeof systems): Geographic {
  const s = systems[system]
  return inverseGaussKruger({ x: point.x - s.falseNorthing, y: point.y - s.falseEasting }, s.centralMeridian)
}

export function geographicToGrid(geo: Geographic, system: keyof typeof systems): Point {
  const s = systems[system]
  const p = forwardGaussKruger(geo, s.centralMeridian)
  return { x: p.x + s.falseNorthing, y: p.y + s.falseEasting }
}

export function msk42ToSk63(point: Point): Point { return geographicToGrid(gridToGeographic(point, 'msk42'), 'sk63') }
export function sk63ToMsk42(point: Point): Point { return geographicToGrid(gridToGeographic(point, 'sk63'), 'msk42') }

function geodeticToGeocentric(geo: Geographic, e: Ellipsoid): [number, number, number] {
  const b = geo.lat * rad
  const l = geo.lon * rad
  const { e2 } = parameters(e)
  const n = e.a / Math.sqrt(1 - e2 * Math.sin(b) ** 2)
  return [n * Math.cos(b) * Math.cos(l), n * Math.cos(b) * Math.sin(l), n * (1 - e2) * Math.sin(b)]
}

function geocentricToGeodetic([x, y, z]: [number, number, number], e: Ellipsoid): Geographic {
  const { e2 } = parameters(e)
  const p = Math.hypot(x, y)
  let b = Math.atan2(z, p * (1 - e2))
  // Stable fixed-point expression with zero ellipsoidal height (the convention of the workbook).
  for (let i = 0; i < 8; i++) {
    const n = e.a / Math.sqrt(1 - e2 * Math.sin(b) ** 2)
    b = Math.atan2(z + e2 * n * Math.sin(b), p)
  }
  return { lat: b * deg, lon: Math.atan2(y, x) * deg }
}

// Bursa–Wolf transform Pulkovo-1942 / Krasovsky → WGS-84, values from the workbook.
const helmert = { dx: 23.844, dy: -141.2781, dz: -80.8466, rx: -0.000384 * rad / 3600, ry: 0.352166 * rad / 3600, rz: 0.81863 * rad / 3600, s: -0.122003e-6 }

function pulkovoToWgs([x, y, z]: [number, number, number]): [number, number, number] {
  const { dx, dy, dz, rx, ry, rz, s } = helmert
  const k = 1 + s
  return [dx + k * (x - rz * y + ry * z), dy + k * (rz * x + y - rx * z), dz + k * (-ry * x + rx * y + z)]
}

function wgsToPulkovo([x, y, z]: [number, number, number]): [number, number, number] {
  // Exact inverse of the small rotation/scale matrix (rather than merely negating parameters).
  const { dx, dy, dz, rx, ry, rz, s } = helmert
  const k = 1 + s
  const a11 = 1, a12 = -rz, a13 = ry
  const a21 = rz, a22 = 1, a23 = -rx
  const a31 = -ry, a32 = rx, a33 = 1
  const qx = (x - dx) / k, qy = (y - dy) / k, qz = (z - dz) / k
  const det = a11 * (a22 * a33 - a23 * a32) - a12 * (a21 * a33 - a23 * a31) + a13 * (a21 * a32 - a22 * a31)
  return [
    ((a22 * a33 - a23 * a32) * qx + (a13 * a32 - a12 * a33) * qy + (a12 * a23 - a13 * a22) * qz) / det,
    ((a23 * a31 - a21 * a33) * qx + (a11 * a33 - a13 * a31) * qy + (a13 * a21 - a11 * a23) * qz) / det,
    ((a21 * a32 - a22 * a31) * qx + (a12 * a31 - a11 * a32) * qy + (a11 * a22 - a12 * a21) * qz) / det
  ]
}

/** Pulkovo-1942 geodetic coordinates (Krasovsky) → WGS-84. */
export function pulkovoToWgs84(geo: Geographic): Geographic {
  return geocentricToGeodetic(pulkovoToWgs(geodeticToGeocentric(geo, krasovsky)), wgs84)
}

/** WGS-84 → Pulkovo-1942 geodetic coordinates (Krasovsky). */
export function wgs84ToPulkovo(geo: Geographic): Geographic {
  return geocentricToGeodetic(wgsToPulkovo(geodeticToGeocentric(geo, wgs84)), krasovsky)
}

export function sk63ToWgs84(point: Point): Geographic {
  return pulkovoToWgs84(gridToGeographic(point, 'sk63'))
}

export function wgs84ToSk63(geo: Geographic): Point {
  return geographicToGrid(wgs84ToPulkovo(geo), 'sk63')
}

export function msk42ToWgs84(point: Point): Geographic {
  return pulkovoToWgs84(gridToGeographic(point, 'msk42'))
}

export function wgs84ToMsk42(geo: Geographic): Point {
  return geographicToGrid(wgs84ToPulkovo(geo), 'msk42')
}

/**
 * Map-only registration per basemap, in metres of local east/north.
 *
 * The two basemaps disagree with each other by about eight metres over Sevastopol,
 * so one shift cannot serve both:
 *
 * - `satellite` — Esri World Imagery, measured in QGIS/GDAL against the МСК-42
 *   «Севастополь» orthophoto mosaics (user-supplied Gauss-Krüger definition:
 *   CM 33°, FE −18 001.8, FN −4 915 002.6, GCS_Pulkovo_1942, Красовский — identical
 *   to our МСК-42). Fourteen measurements over an 80 km span, namely the five СК-42
 *   points at z17 and z18 plus six randomly picked mosaics, all returned the same
 *   translation: median +5.10 m east (MAD 0.22 m) and +5.97 m north (MAD 1.07 m),
 *   with no rotation and no scale. Rounded to +5.1 m east and +6.0 m north.
 * - `scheme` — the OSM raster scheme, whose coastline agrees with the drawing's own
 *   shoreline: 1340 shoreline-coincident vertices of «границы севастополя.dxf» gave
 *   +0.61 m east and +0.20 m north (MAD ≈ 1.9 m), i.e. a sub-metre refinement.
 *
 * Both are map-display only: the workbook datum transform and every converter
 * result are unaffected.
 */
export const mapCalibration = {
  satellite: { east: 5.1, north: 6.0 },
  scheme: { east: 0.6, north: 0.2 }
} as const

export type BasemapId = keyof typeof mapCalibration

/**
 * Place a local drawing point on the active basemap: the workbook conversion plus
 * that basemap's measured registration. `system` is the grid the drawing coordinates
 * are in, `basemap` selects the shift matching what is currently on screen.
 */
export function drawingToMapWgs84(point: Point, system: 'msk42' | 'sk63', basemap: BasemapId = 'satellite'): Geographic {
  const offset = mapCalibration[basemap]
  const registered = { x: point.x + offset.north, y: point.y + offset.east }
  return pulkovoToWgs84(gridToGeographic(registered, system))
}

export function parseCoordinate(input: string, kind: 'lat' | 'lon'): number {
  const raw = input.trim().replace(',', '.')
  if (!raw) throw new Error('Пустая координата')
  if (!/[°′'″"]/u.test(raw)) {
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`Не удалось прочитать «${input}»`)
    return validateCoordinate(value, kind)
  }
  const normal = raw.replace(/[′]/gu, "'").replace(/[″]/gu, '"').replace(/\s+/g, '')
  const match = normal.match(/^(-?\d+(?:\.\d+)?)°(?:\s*)?(\d+(?:\.\d+)?)?'?(?:\s*)?(\d+(?:\.\d+)?)?"?([NSEW])?$/i)
  if (!match) throw new Error(`Неверный DMS: «${input}»`)
  const d = Number(match[1]), m = Number(match[2] ?? 0), s = Number(match[3] ?? 0)
  if (m >= 60 || s >= 60) throw new Error('Минуты и секунды должны быть меньше 60')
  const hemisphere = match[4]?.toUpperCase()
  let value = Math.abs(d) + m / 60 + s / 3600
  if (d < 0 || hemisphere === 'S' || hemisphere === 'W') value *= -1
  return validateCoordinate(value, kind)
}

function validateCoordinate(value: number, kind: 'lat' | 'lon'): number {
  const limit = kind === 'lat' ? 90 : 180
  if (Math.abs(value) > limit) throw new Error(kind === 'lat' ? 'Широта должна быть от −90 до 90°' : 'Долгота должна быть от −180 до 180°')
  return value
}

export function formatDms(value: number, kind: 'lat' | 'lon', decimals = 5): string {
  const hemisphere = kind === 'lat' ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E')
  let totalSeconds = Math.round(Math.abs(value) * 3600 * 10 ** decimals) / 10 ** decimals
  const d = Math.floor(totalSeconds / 3600)
  totalSeconds -= d * 3600
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds - m * 60
  return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(decimals).padStart(decimals + 3, '0')}"${hemisphere}`
}

export function formatNumber(value: number, decimals = 3): string { return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value) }
