import './style.css'
import 'leaflet/dist/leaflet.css'
import * as L from 'leaflet'
import {
  drawingToMapWgs84,
  formatDms,
  formatNumber,
  mapCalibration,
  msk42ToSk63,
  parseCoordinate,
  sk63ToMsk42,
  sk63ToWgs84,
  wgs84ToSk63
} from './coordinates'
import type { BasemapId } from './coordinates'
import { registerSW } from 'virtual:pwa-register'

type Mode = 'msk-sk' | 'sk-msk' | 'sk-wgs' | 'wgs-sk' | 'dms'
type Row = { id: number; first: string; second: string }
type Result = { a: string; b: string; da?: string; db?: string }
type MapPoint = { lat: number; lon: number; row: number }

const labels: Record<Mode, { title: string; intro: string; first: string; second: string; out1: string; out2: string }> = {
  'msk-sk': { title: 'МСК-42 → СК-63', intro: 'Введите плоские координаты: X — север, Y — восток.', first: 'X МСК-42, м', second: 'Y МСК-42, м', out1: 'X СК-63, м', out2: 'Y СК-63, м' },
  'sk-msk': { title: 'СК-63 → МСК-42', intro: 'Введите плоские координаты: X — север, Y — восток.', first: 'X СК-63, м', second: 'Y СК-63, м', out1: 'X МСК-42, м', out2: 'Y МСК-42, м' },
  'sk-wgs': { title: 'СК-63 → WGS-84', intro: 'Выполняется преобразование датума Пулково-1942 → WGS-84.', first: 'X СК-63, м', second: 'Y СК-63, м', out1: 'Широта WGS-84', out2: 'Долгота WGS-84' },
  'wgs-sk': { title: 'WGS-84 → СК-63', intro: 'Широту и долготу можно задать десятичными градусами или DMS, например 44°29\'56.25790"N.', first: 'Широта WGS-84', second: 'Долгота WGS-84', out1: 'X СК-63, м', out2: 'Y СК-63, м' },
  dms: { title: 'WGS-84: DMS → десятичные', intro: 'Конвертер принимает DMS с точкой или запятой: 44°35\'44.84"N.', first: 'Широта (DMS или °)', second: 'Долгота (DMS или °)', out1: 'Широта, °', out2: 'Долгота, °' }
}

let mode: Mode = 'msk-sk'
let rows: Row[] = [{ id: 1, first: '', second: '' }]
let id = 2
let map: L.Map | undefined
let markerLayer: L.LayerGroup | undefined
let previousMapPointCount = 0
// Which basemap is on screen decides the registration: the Esri imagery and the OSM
// scheme sit about eight metres apart here, so the marker shift follows the basemap.
let basemap: BasemapId = 'satellite'
// The GPS fix is one sample kept in memory: it survives a re-render and is re-registered
// when the basemap changes, but it is never tracked continuously, so the phone's GPS is
// only switched on for the moment the button is pressed.
let fix: { lat: number; lon: number; accuracy: number } | null = null
let fixLayer: L.LayerGroup | undefined
// Map marks: a small red disc with the row number inside. The size is shared with the
// canvas export, so the saved picture matches what is on screen.
const MARKER_SIZE = 14
const MARKER_COLOR = '#d32f2f'
const MAP_BACKGROUND = '#172126'
// Kept so the picture export can repaint the same tile layers that are switched on.
const tileLayers: { satellite: L.TileLayer | null; overlay: L.TileLayer | null; scheme: L.TileLayer | null } = {
  satellite: null,
  overlay: null,
  scheme: null
}

function number(value: string, title: string): number {
  const n = Number(value.trim().replace(',', '.').replace(/\s/g, ''))
  if (!Number.isFinite(n)) throw new Error(`${title}: укажите число`)
  return n
}

function signedMetres(value: number): string {
  return `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(1).replace('.', ',')}`
}

function updateCalibrationLabel() {
  const element = document.querySelector<HTMLSpanElement>('#map-calibration')
  if (!element) return
  const offset = mapCalibration[basemap]
  const name = basemap === 'satellite' ? 'спутник Esri' : 'схема OSM'
  element.textContent = `Привязка карты (${name}): X (север) ${signedMetres(offset.north)} м · Y (восток) ${signedMetres(offset.east)} м`
}

function convert(row: Row): Result {
  const info = labels[mode]
  if (!row.first.trim() && !row.second.trim()) return { a: '—', b: '—' }
  if (!row.first.trim() || !row.second.trim()) throw new Error('Заполните обе координаты')
  if (mode === 'msk-sk') {
    const p = msk42ToSk63({ x: number(row.first, info.first), y: number(row.second, info.second) })
    return { a: formatNumber(p.x), b: formatNumber(p.y) }
  }
  if (mode === 'sk-msk') {
    const p = sk63ToMsk42({ x: number(row.first, info.first), y: number(row.second, info.second) })
    return { a: formatNumber(p.x), b: formatNumber(p.y) }
  }
  if (mode === 'sk-wgs') {
    const p = sk63ToWgs84({ x: number(row.first, info.first), y: number(row.second, info.second) })
    return { a: formatNumber(p.lat, 8), b: formatNumber(p.lon, 8), da: formatDms(p.lat, 'lat'), db: formatDms(p.lon, 'lon') }
  }
  if (mode === 'wgs-sk') {
    const p = wgs84ToSk63({ lat: parseCoordinate(row.first, 'lat'), lon: parseCoordinate(row.second, 'lon') })
    return { a: formatNumber(p.x), b: formatNumber(p.y) }
  }
  const lat = parseCoordinate(row.first, 'lat'), lon = parseCoordinate(row.second, 'lon')
  return { a: formatNumber(lat, 8), b: formatNumber(lon, 8), da: formatDms(lat, 'lat'), db: formatDms(lon, 'lon') }
}

function mapPoint(row: Row, rowNumber: number): MapPoint | undefined {
  if (!row.first.trim() || !row.second.trim()) return undefined
  if (mode === 'msk-sk') {
    const point = { x: number(row.first, labels[mode].first), y: number(row.second, labels[mode].second) }
    return { ...drawingToMapWgs84(point, 'msk42', basemap), row: rowNumber }
  }
  if (mode === 'sk-msk' || mode === 'sk-wgs') {
    const point = { x: number(row.first, labels[mode].first), y: number(row.second, labels[mode].second) }
    return { ...drawingToMapWgs84(point, 'sk63', basemap), row: rowNumber }
  }
  const lat = parseCoordinate(row.first, 'lat'), lon = parseCoordinate(row.second, 'lon')
  return { lat, lon, row: rowNumber }
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]!))
}

function resultMarkup(result: Result, key: 'a' | 'b'): string {
  const value = result[key]
  const dms = key === 'a' ? result.da : result.db
  return `${value}${dms ? `<small>${dms}</small>` : ''}`
}

function renderRow(row: Row, index: number, info: typeof labels[Mode]): string {
  let result: Result | undefined
  let error = ''
  try { result = convert(row) } catch (cause) { error = cause instanceof Error ? cause.message : 'Ошибка расчёта' }
  return `<tr data-row-id="${row.id}" class="${error ? 'error' : ''}">
    <td>${index + 1}</td>
    <td><input data-id="${row.id}" data-key="first" aria-label="${info.first}" value="${escape(row.first)}" placeholder="${info.first}"></td>
    <td><input data-id="${row.id}" data-key="second" aria-label="${info.second}" value="${escape(row.second)}" placeholder="${info.second}"></td>
    <td class="out" data-output="a" ${error ? 'hidden' : ''}>${result ? resultMarkup(result, 'a') : ''}</td>
    <td class="out" data-output="b" ${error ? 'hidden' : ''}>${result ? resultMarkup(result, 'b') : ''}</td>
    <td colspan="2" class="message" data-error ${error ? '' : 'hidden'}>${escape(error)}</td>
    <td><button class="icon" data-remove="${row.id}" title="Удалить строку" aria-label="Удалить строку">×</button></td>
  </tr>`
}

function render() {
  if (map) { map.remove(); map = undefined; markerLayer = undefined; fixLayer = undefined }
  previousMapPointCount = 0
  const info = labels[mode]
  const resultRows = rows.map((row, index) => renderRow(row, index, info)).join('')
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
    <header><div class="brand"><span class="mark">⌖</span><div><strong>Конвертер координат</strong><small>Севастополь · МСК-42 · СК-63 зона 4 · WGS-84</small></div></div><span id="net" class="status">${navigator.onLine ? 'Онлайн' : 'Офлайн'}</span></header>
    <main>
      <section class="hero"><p class="eyebrow">ТОЧНОЕ ПРЕОБРАЗОВАНИЕ</p><h1>${info.title}</h1><p>${info.intro}</p></section>
      <nav aria-label="Выбор преобразования">${(Object.keys(labels) as Mode[]).map(key => `<button class="mode ${mode === key ? 'active' : ''}" data-mode="${key}">${labels[key].title}</button>`).join('')}</nav>
      <section class="panel"><div class="panel-head"><div><h2>Координаты</h2><p>Можно вставить сразу несколько строк из Excel: два значения, разделённые табуляцией, точкой с запятой или запятой.</p></div><div class="actions"><button id="paste" class="secondary">Вставить список</button><button id="clear" class="secondary">Очистить</button><button id="copy" class="primary">Скопировать результат</button></div></div>
      <div class="table-scroll"><table><thead><tr><th>№</th><th>${info.first}</th><th>${info.second}</th><th>${info.out1}</th><th>${info.out2}</th><th></th></tr></thead><tbody>${resultRows}</tbody></table></div>
      <button id="add" class="add">＋ Добавить строку</button></section>
      <section class="map-panel panel" aria-label="Карта точек">
        <div class="panel-head map-head"><div><h2>Точки на карте Севастополя</h2><p>Маркеры соответствуют заполненным строкам таблицы.</p></div><div class="map-head-actions"><span class="map-calibration" id="map-calibration"></span><button id="map-locate" class="secondary" type="button">Показать меня</button><button id="map-download" class="secondary" type="button">Скачать картинку</button></div></div>
        <div id="map" role="application" aria-label="Интерактивная карта Севастополя"></div>
        <p id="map-status" class="map-status" aria-live="polite">Нет заполненных точек.</p>
        <p id="map-location" class="map-location" aria-live="polite" hidden></p>
        <p class="map-note">Привязка только для карты и не влияет на результаты конвертера, и она переключается вместе с подложкой, потому что подложки смещены друг относительно друга примерно на восемь метров. Для спутниковых снимков Esri сдвиг измерен в QGIS/GDAL по ортофотопланам МСК-42 «Севастополь»: 14 замеров по городу (пять точек на двух зумах и шесть случайных планшетов) дали одинаковое смещение с медианой +5,1 м восток и +6,0 м север, разброс около 1 м, без разворота и масштаба. Для схемы OSM сдвиг измерен наложением береговой линии чертежа «границы севастополя.dxf»: +0,6 м восток и +0,2 м север при разбросе около 2 м. Подложки загружаются из интернета; без сети вычисления работают, но карта может быть пустой. Кнопка «Показать меня» берёт одно измерение GPS и сдвигает его той же поправкой, что и маркеры, поэтому ваша отметка и точки на снимке лежат в одной системе координат. Круг вокруг отметки — это точность телефона, обычно ±3–10 м; поправка убирает систематический сдвиг подложки, но не заменяет точность приёмника.</p>
      </section>
      <section class="note"><h2>О методике</h2><p>Плоские координаты вычисляются в проекции Гаусса—Крюгера на эллипсоиде Красовского 1940. Для WGS-84 применяется 7-параметрическое преобразование Пулково-1942 → WGS-84 из исходной книги. Преобразования и маркеры рассчитываются в браузере; введённые координаты не отправляются. Для карты загружаются тайлы спутниковых снимков и подписей видимой области, поэтому серверы тайлов получают запросы о просматриваемом районе.</p><p><b>Автономный режим:</b> откройте сайт один раз в сети, затем выберите «Установить приложение» в браузере — конвертер и его формулы останутся доступны без интернета.</p></section>
    </main><footer>Версия 1.0 · Проверяйте результат на контрольных точках перед производственным применением.</footer>`
  bind()
  setupMap()
}

function setupMap() {
  const element = document.querySelector<HTMLDivElement>('#map')
  if (!element) return
  map = L.map(element, { zoomControl: true, preferCanvas: true, maxZoom: 19 }).setView([44.6166, 33.5253], 12)

  const osmAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  // Satellite imagery: no key needed, real coverage down to z19 over the city.
  // crossOrigin lets the canvas export draw these tiles into a saved PNG.
  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, crossOrigin: true, attribution: 'Снимки &copy; <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics' }
  )
  // Streets and place names drawn over the imagery: OSM keeps Russian names at every
  // zoom, which the Esri label service does not offer above z15 here.
  const overlay = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    subdomains: 'abc',
    maxZoom: 19,
    crossOrigin: true,
    opacity: 0.5,
    className: 'map-overlay-tile',
    attribution: osmAttribution
  })
  const scheme = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    subdomains: 'abc',
    maxZoom: 19,
    crossOrigin: true,
    className: 'map-scheme-tile',
    attribution: osmAttribution
  })

  satellite.addTo(map)
  overlay.addTo(map)
  tileLayers.satellite = satellite
  tileLayers.overlay = overlay
  tileLayers.scheme = scheme
  // On a phone the expanded switcher would cover most of the map, so it starts folded there.
  const narrowScreen = window.matchMedia('(max-width: 700px)').matches
  L.control.layers({ 'Спутник': satellite, 'Схема OSM': scheme }, { 'Улицы и подписи': overlay }, { collapsed: narrowScreen, position: 'topright' }).addTo(map)
  // Switching the basemap switches the registration, so the markers are recomputed
  // against whatever imagery is actually on screen.
  map.on('baselayerchange', event => {
    basemap = event.name === 'Схема OSM' ? 'scheme' : 'satellite'
    updateCalibrationLabel()
    updateMapMarkers()
    // The GPS dot carries the registration of the basemap too, so it moves with the switch.
    drawFix()
    updateFixText()
  })

  markerLayer = L.layerGroup().addTo(map)
  // Held separately from the markers so a fresh re-render or a basemap switch can update
  // the dot on its own, and so the dot always sits above the numbered points.
  fixLayer = L.layerGroup().addTo(map)
  window.setTimeout(() => map?.invalidateSize(), 0)
  document.querySelector<HTMLButtonElement>('#map-download')?.addEventListener('click', () => { void downloadMapImage() })
  document.querySelector<HTMLButtonElement>('#map-locate')?.addEventListener('click', () => { void locateMe() })
  updateCalibrationLabel()
  updateMapMarkers(true)
  drawFix()
  updateFixText()
}

function collectMapPoints(): MapPoint[] {
  const points: MapPoint[] = []
  rows.forEach((row, index) => {
    try {
      const point = mapPoint(row, index + 1)
      if (point && Number.isFinite(point.lat) && Number.isFinite(point.lon)) points.push(point)
    } catch { /* Invalid/incomplete rows are omitted from the map until corrected. */ }
  })
  return points
}

type ExportLayer = { layer: L.TileLayer; opacity: number; filter: string }

/** Reads a filter from the stylesheet instead of repeating it here, so the exported
 *  picture cannot drift away from what the map itself shows. */
function classFilter(className: string): string {
  if (!className) return 'none'
  const probe = document.createElement('div')
  probe.className = className
  probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden'
  document.body.appendChild(probe)
  const filter = window.getComputedStyle(probe).filter
  probe.remove()
  return filter && filter !== 'none' ? filter : 'none'
}

/** Tile layers to paint, in map order: basemap, then the label overlay or the scheme. */
function exportLayers(): ExportLayer[] {
  if (!map) return []
  const candidates: Array<[L.TileLayer | null, string]> = [
    [tileLayers.satellite, ''],
    [tileLayers.overlay, 'map-overlay-tile'],
    [tileLayers.scheme, 'map-scheme-tile']
  ]
  const active: ExportLayer[] = []
  candidates.forEach(([layer, className]) => {
    if (!layer || !map!.hasLayer(layer)) return
    active.push({ layer, opacity: layer.options.opacity ?? 1, filter: classFilter(className) })
  })
  return active
}

/** Leaflet animates zooms and pans, and during those the map still reports the previous
 *  zoom in its layers; wait for the animation classes to go before measuring the view. */
async function whenSettled(timeout = 3000) {
  if (!map) return
  const container = map.getContainer()
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!container.querySelector('.leaflet-zoom-anim, .leaflet-pan-anim')) return
    await new Promise<void>(resolve => { window.setTimeout(resolve, 60) })
  }
}

/** Tiles are requested by URL and placed from the map geometry rather than copied from the
 *  <img> elements on screen: Leaflet keeps freshly loaded tiles at opacity 0 while they
 *  fade in and scales the previous zoom level while it animates, which is how the download
 *  used to come out with an empty basemap. */
async function drawTileLayer(context: CanvasRenderingContext2D, entry: ExportLayer, view: L.Point) {
  if (!map) return
  const zoom = map.getZoom()
  const size = entry.layer.getTileSize()
  const bounds = map.getPixelBounds()
  const topLeft = bounds.min
  const bottomRight = bounds.max
  if (!topLeft || !bottomRight) return
  const first = topLeft.divideBy(size.x).floor()
  const last = bottomRight.divideBy(size.x).floor()
  const pending: Array<Promise<void>> = []
  for (let x = first.x; x <= last.x; x++) {
    for (let y = first.y; y <= last.y; y++) {
      const corner = map.latLngToContainerPoint(map.unproject(L.point(x * size.x, y * size.y), zoom))
      const left = Math.round(corner.x)
      const top = Math.round(corner.y)
      if (left + size.x <= 0 || top + size.y <= 0 || left >= view.x || top >= view.y) continue
      const coords = L.point(x, y) as L.Coords
      coords.z = zoom
      const url = entry.layer.getTileUrl(coords)
      pending.push(new Promise<void>(resolve => {
        const image = new Image()
        image.crossOrigin = 'anonymous'
        image.onload = () => {
          context.globalAlpha = entry.opacity
          context.filter = entry.filter
          context.drawImage(image, left, top, size.x, size.y)
          resolve()
        }
        image.onerror = () => resolve()
        image.src = url
      }))
    }
  }
  await Promise.all(pending)
}

async function downloadMapImage() {
  const status = document.querySelector<HTMLParagraphElement>('#map-status')
  const button = document.querySelector<HTMLButtonElement>('#map-download')
  if (!map) return
  button?.setAttribute('disabled', '')
  const report = (message: string) => {
    if (!status) return
    status.textContent = message
    window.setTimeout(() => {
      const count = collectMapPoints().length
      status.textContent = count ? `На карте отмечено точек: ${count}.` : 'Нет корректно заполненных точек.'
    }, 6000)
  }
  try {
    if (status) status.textContent = 'Готовлю картинку…'
    await whenSettled()
    const view = map.getSize()
    const points = collectMapPoints()
    // Render at the display density so marker numbers and labels stay sharp.
    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(view.x * scale)
    canvas.height = Math.round(view.y * scale)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas недоступен')
    context.setTransform(scale, 0, 0, scale, 0, 0)
    context.fillStyle = MAP_BACKGROUND
    context.fillRect(0, 0, view.x, view.y)

    for (const entry of exportLayers()) await drawTileLayer(context, entry, view)
    context.globalAlpha = 1
    context.filter = 'none'

    points.forEach(point => {
      const position = map!.latLngToContainerPoint([point.lat, point.lon])
      drawMapMark(context, position.x, position.y, String(point.row))
    })
    drawMapFooter(context, view.x, view.y, points.length)

    const blob = await new Promise<Blob | null>(resolve => { canvas.toBlob(value => resolve(value), 'image/png') })
    if (!blob) throw new Error('браузер не собрал PNG')
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `sevastopol-points-${stamp}.png`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(link.href), 10000)
    report(`Картинка сохранена: ${points.length ? `точек ${points.length}` : 'без точек'} · ${canvas.width}×${canvas.height} px.`)
  } catch (cause) {
    report(`Не удалось сохранить картинку: ${cause instanceof Error ? cause.message : 'неизвестная ошибка'}`)
  } finally {
    button?.removeAttribute('disabled')
  }
}

/** Same look as the on-screen `.numbered-map-marker`, drawn for the exported PNG. */
function drawMapMark(context: CanvasRenderingContext2D, x: number, y: number, label: string) {
  const radius = MARKER_SIZE / 2
  context.save()
  context.shadowColor = 'rgba(0, 0, 0, 0.55)'
  context.shadowBlur = 4
  context.beginPath()
  context.arc(x, y, radius, 0, Math.PI * 2)
  context.fillStyle = MARKER_COLOR
  context.fill()
  context.restore()
  context.beginPath()
  context.arc(x, y, radius - 0.5, 0, Math.PI * 2)
  context.lineWidth = 1
  context.strokeStyle = '#ffffff'
  context.stroke()
  context.fillStyle = '#ffffff'
  context.font = '800 8px system-ui, sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(label, x, y + 0.5)
}

function drawMapFooter(context: CanvasRenderingContext2D, width: number, height: number, count: number) {
  const bar = 30
  const offset = mapCalibration[basemap]
  const source = basemap === 'satellite' ? 'спутник Esri' : 'схема OSM'
  const stamp = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  context.fillStyle = 'rgba(10, 20, 24, 0.74)'
  context.fillRect(0, height - bar, width, bar)
  context.textAlign = 'left'
  context.textBaseline = 'alphabetic'
  context.font = '600 9px system-ui, sans-serif'
  context.fillStyle = '#e8f2ef'
  context.fillText('Снимки © Esri, Maxar, Earthstar Geographics · Подписи © OpenStreetMap contributors · Leaflet', 10, height - bar + 12)
  context.fillStyle = '#a9c4bd'
  context.fillText(`Конвертер координат, Севастополь · ${stamp} · точек: ${count} · привязка ${source}: ${signedMetres(offset.east)} м E / ${signedMetres(offset.north)} м N`, 10, height - bar + 24)
}

function updateMapMarkers(forceFit = false) {
  if (!map || !markerLayer) return
  markerLayer.clearLayers()
  const points = collectMapPoints()
  points.forEach(point => {
    const icon = L.divIcon({ className: 'numbered-map-marker', html: String(point.row), iconSize: [MARKER_SIZE, MARKER_SIZE], iconAnchor: [MARKER_SIZE / 2, MARKER_SIZE / 2] })
    L.marker([point.lat, point.lon], { icon, title: `Точка ${point.row}` })
      .bindTooltip(`Точка ${point.row}`)
      .bindPopup(`<b>Точка ${point.row}</b><br>${point.lat.toFixed(8)}°, ${point.lon.toFixed(8)}°`)
      .addTo(markerLayer!)
  })
  const status = document.querySelector<HTMLParagraphElement>('#map-status')
  if (status) status.textContent = points.length ? `На карте отмечено точек: ${points.length}.` : 'Нет корректно заполненных точек.'
  if (points.length && (forceFit || previousMapPointCount === 0)) {
    const bounds = L.latLngBounds(points.map(point => [point.lat, point.lon] as L.LatLngTuple))
    if (points.length === 1) map.setView(bounds.getCenter(), 15)
    else map.fitBounds(bounds, { padding: [28, 28], maxZoom: 15 })
  }
  previousMapPointCount = points.length
  // The distance to the nearest point changes whenever the table does.
  updateFixText()
}

/** The registration is a property of the basemap, not of the object drawn on it, so the GPS
 *  fix goes through exactly the same shift as a marker of the same point: convert the fix
 *  into the drawing frame, then let drawingToMapWgs84 add the basemap offset. The dot and
 *  the numbered points then share one frame, and the distance between them is the real one. */
function fixInMapFrame(sample: { lat: number; lon: number }): { lat: number; lon: number } {
  return drawingToMapWgs84(wgs84ToSk63({ lat: sample.lat, lon: sample.lon }), 'sk63', basemap)
}

function drawFix() {
  if (!map || !fixLayer) return
  fixLayer.clearLayers()
  if (!fix) return
  const point = fixInMapFrame(fix)
  const accuracy = Number.isFinite(fix.accuracy) ? fix.accuracy : 0
  const offset = mapCalibration[basemap]
  // The circle is the receiver's own accuracy; the map shift neither grows nor shrinks it.
  if (accuracy > 0) {
    L.circle([point.lat, point.lon], {
      radius: accuracy, color: '#3b9dff', weight: 1, opacity: 0.75,
      fillColor: '#3b9dff', fillOpacity: 0.12, interactive: false
    }).addTo(fixLayer)
  }
  L.circleMarker([point.lat, point.lon], { radius: 7, color: '#ffffff', weight: 2, fillColor: '#3b9dff', fillOpacity: 1 })
    .bindTooltip(`Вы здесь · точность ±${accuracy.toFixed(0)} м`)
    .bindPopup(`<b>Вы здесь</b><br>Широта ${fix.lat.toFixed(8)}°, долгота ${fix.lon.toFixed(8)}°<br>Точность GPS ±${accuracy.toFixed(1)} м<br><small>На карте сдвинуто на поправку подложки: X (север) ${signedMetres(offset.north)} м · Y (восток) ${signedMetres(offset.east)} м</small>`)
    .addTo(fixLayer)
}

function bearingTowards(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number {
  const radians = (value: number) => value * Math.PI / 180
  const lat1 = radians(from.lat)
  const lat2 = radians(to.lat)
  const deltaLon = radians(to.lon - from.lon)
  const y = Math.sin(deltaLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

/** Nearest filled row to the current fix: both sides are already in the basemap frame, and
 *  because the shift is the same for both, the distance is the true ground distance. */
function nearestTarget(): { row: number; distance: number; bearing: number } | null {
  if (!fix) return null
  const from = fixInMapFrame(fix)
  const origin = L.latLng(from.lat, from.lon)
  let best: { row: number; distance: number; bearing: number } | null = null
  for (const point of collectMapPoints()) {
    const distance = origin.distanceTo(L.latLng(point.lat, point.lon))
    if (!best || distance < best.distance) best = { row: point.row, distance, bearing: bearingTowards(from, point) }
  }
  return best
}

function updateFixText() {
  const element = document.querySelector<HTMLParagraphElement>('#map-location')
  if (!element) return
  if (!fix) {
    element.hidden = true
    element.textContent = ''
    return
  }
  const accuracy = Number.isFinite(fix.accuracy) ? fix.accuracy : 0
  const head = `Ваше положение ${fix.lat.toFixed(6)}°, ${fix.lon.toFixed(6)}° · точность GPS ±${accuracy.toFixed(0)} м`
  const target = nearestTarget()
  element.hidden = false
  if (!target) {
    element.textContent = `${head}. Заполненных точек пока нет.`
    return
  }
  const distance = target.distance < 10 ? target.distance.toFixed(1) : target.distance.toFixed(0)
  const tail = `до точки ${target.row}: ${distance.replace('.', ',')} м, азимут ${target.bearing.toFixed(0)}°`
  // Only claim "on site" when the point falls inside the receiver's own error circle.
  element.textContent = target.distance <= Math.max(accuracy, 4)
    ? `${head} · ${tail} · вы на месте`
    : `${head} · ${tail}`
}

/** One fix on demand: the browser asks for permission the first time only, and the GPS is
 *  not left running afterwards, so the battery is untouched the rest of the time. */
async function locateMe() {
  const button = document.querySelector<HTMLButtonElement>('#map-locate')
  const element = document.querySelector<HTMLParagraphElement>('#map-location')
  const report = (message: string) => {
    if (!element) return
    element.hidden = false
    element.textContent = message
  }
  if (!window.isSecureContext) {
    report('Геолокация работает только по HTTPS. Откройте сайт по защищённому адресу.')
    return
  }
  if (!navigator.geolocation) {
    report('Этот браузер не поддерживает геолокацию.')
    return
  }
  button?.setAttribute('disabled', '')
  report('Определяю положение… Разрешите доступ, если браузер спросит.')
  try {
    const sample = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 })
    })
    fix = { lat: sample.coords.latitude, lon: sample.coords.longitude, accuracy: sample.coords.accuracy }
    drawFix()
    updateFixText()
    // Bring the dot into view only when it is off screen, so the view of the points is kept.
    const point = fixInMapFrame(fix)
    if (map && !map.getBounds().contains([point.lat, point.lon])) map.setView([point.lat, point.lon], 16)
  } catch (cause) {
    const code = (cause as GeolocationPositionError | undefined)?.code
    report(code === 1
      ? 'Доступ к геолокации запрещён. Разрешите его в настройках браузера и нажмите «Показать меня» снова.'
      : code === 3
        ? 'GPS не ответил вовремя. Выйдите на открытое место и попробуйте снова.'
        : 'Не удалось определить положение. Проверьте, включён ли GPS.')
  } finally {
    button?.removeAttribute('disabled')
  }
}

function updateRow(row: Row) {
  const element = document.querySelector<HTMLTableRowElement>(`tr[data-row-id="${row.id}"]`)
  if (!element) return
  const outputA = element.querySelector<HTMLTableCellElement>('[data-output="a"]')!
  const outputB = element.querySelector<HTMLTableCellElement>('[data-output="b"]')!
  const error = element.querySelector<HTMLTableCellElement>('[data-error]')!
  try {
    const result = convert(row)
    outputA.innerHTML = resultMarkup(result, 'a')
    outputB.innerHTML = resultMarkup(result, 'b')
    outputA.hidden = false
    outputB.hidden = false
    error.hidden = true
    error.textContent = ''
    element.classList.remove('error')
  } catch (cause) {
    outputA.hidden = true
    outputB.hidden = true
    error.hidden = false
    error.textContent = cause instanceof Error ? cause.message : 'Ошибка расчёта'
    element.classList.add('error')
  }
  updateMapMarkers()
}

function bind() {
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.onclick = () => { mode = button.dataset.mode as Mode; render() })
  document.querySelectorAll<HTMLInputElement>('input[data-id]').forEach(input => input.oninput = () => {
    const row = rows.find(r => r.id === Number(input.dataset.id))
    if (!row) return
    row[input.dataset.key as 'first' | 'second'] = input.value
    updateRow(row)
  })
  document.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(button => button.onclick = () => { rows = rows.filter(r => r.id !== Number(button.dataset.remove)); if (!rows.length) rows = [{ id: id++, first: '', second: '' }]; render() })
  document.querySelector<HTMLButtonElement>('#add')!.onclick = () => { rows.push({ id: id++, first: '', second: '' }); render() }
  document.querySelector<HTMLButtonElement>('#clear')!.onclick = () => { rows = [{ id: id++, first: '', second: '' }]; render() }
  document.querySelector<HTMLButtonElement>('#paste')!.onclick = async () => {
    try {
      const text = await navigator.clipboard.readText()
      const values = text.trim().split(/\r?\n/).map(line => line.trim().split(/\t|;|,(?=\s*[-+\d])/).map(x => x.trim())).filter(x => x.length >= 2)
      if (!values.length) throw new Error('Не найдены строки из двух координат')
      rows = values.map(([first, second]) => ({ id: id++, first, second })); render()
    } catch (error) { alert(error instanceof Error ? error.message : 'Не удалось прочитать буфер обмена') }
  }
  document.querySelector<HTMLButtonElement>('#copy')!.onclick = async () => {
    const data = rows.map((row, i) => { try { const r = convert(row); return [i + 1, row.first, row.second, r.a, r.b].join('\t') } catch { return '' } }).filter(Boolean).join('\n')
    await navigator.clipboard.writeText(data); const button = document.querySelector<HTMLButtonElement>('#copy')!; button.textContent = 'Скопировано'; setTimeout(() => button.textContent = 'Скопировать результат', 1500)
  }
}

window.addEventListener('online', render)
window.addEventListener('offline', render)
registerSW({ immediate: true })
render()
