import './style.css'
import { formatDms, formatNumber, msk42ToSk63, parseCoordinate, sk63ToMsk42, sk63ToWgs84, wgs84ToSk63 } from './coordinates'
import { registerSW } from 'virtual:pwa-register'

type Mode = 'msk-sk' | 'sk-msk' | 'sk-wgs' | 'wgs-sk' | 'dms'
type Row = { id: number; first: string; second: string }

const labels: Record<Mode, { title: string; intro: string; first: string; second: string; out1: string; out2: string; geographic?: boolean }> = {
  'msk-sk': { title: 'МСК-42 → СК-63', intro: 'Введите плоские координаты: X — север, Y — восток.', first: 'X МСК-42, м', second: 'Y МСК-42, м', out1: 'X СК-63, м', out2: 'Y СК-63, м' },
  'sk-msk': { title: 'СК-63 → МСК-42', intro: 'Введите плоские координаты: X — север, Y — восток.', first: 'X СК-63, м', second: 'Y СК-63, м', out1: 'X МСК-42, м', out2: 'Y МСК-42, м' },
  'sk-wgs': { title: 'СК-63 → WGS-84', intro: 'Выполняется преобразование датума Пулково-1942 → WGS-84.', first: 'X СК-63, м', second: 'Y СК-63, м', out1: 'Широта WGS-84', out2: 'Долгота WGS-84', geographic: true },
  'wgs-sk': { title: 'WGS-84 → СК-63', intro: 'Широту и долготу можно задать десятичными градусами или DMS, например 44°29\'56.25790"N.', first: 'Широта WGS-84', second: 'Долгота WGS-84', out1: 'X СК-63, м', out2: 'Y СК-63, м', geographic: true },
  dms: { title: 'WGS-84: DMS → десятичные', intro: 'Конвертер принимает DMS с точкой или запятой: 44°35\'44.84"N.', first: 'Широта (DMS или °)', second: 'Долгота (DMS или °)', out1: 'Широта, °', out2: 'Долгота, °', geographic: true }
}

let mode: Mode = 'msk-sk'
let rows: Row[] = [{ id: 1, first: '', second: '' }]
let id = 2

function number(value: string, title: string): number {
  const n = Number(value.trim().replace(',', '.').replace(/\s/g, ''))
  if (!Number.isFinite(n)) throw new Error(`${title}: укажите число`)
  return n
}

function convert(row: Row): { a: string; b: string; da?: string; db?: string } {
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

function escape(value: string): string { return value.replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]!)) }

function render() {
  const info = labels[mode]
  const resultRows = rows.map((row, index) => {
    try {
      const r = convert(row)
      return `<tr><td>${index + 1}</td><td><input data-id="${row.id}" data-key="first" aria-label="${info.first}" value="${escape(row.first)}" placeholder="${info.first}"></td><td><input data-id="${row.id}" data-key="second" aria-label="${info.second}" value="${escape(row.second)}" placeholder="${info.second}"></td><td class="out">${r.a}${r.da ? `<small>${r.da}</small>` : ''}</td><td class="out">${r.b}${r.db ? `<small>${r.db}</small>` : ''}</td><td><button class="icon" data-remove="${row.id}" title="Удалить строку" aria-label="Удалить строку">×</button></td></tr>`
    } catch (error) {
      return `<tr class="error"><td>${index + 1}</td><td><input data-id="${row.id}" data-key="first" aria-label="${info.first}" value="${escape(row.first)}" placeholder="${info.first}"></td><td><input data-id="${row.id}" data-key="second" aria-label="${info.second}" value="${escape(row.second)}" placeholder="${info.second}"></td><td colspan="2" class="message">${escape(error instanceof Error ? error.message : 'Ошибка расчёта')}</td><td><button class="icon" data-remove="${row.id}" title="Удалить строку">×</button></td></tr>`
    }
  }).join('')
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
    <header><div class="brand"><span class="mark">⌖</span><div><strong>Конвертер координат</strong><small>Севастополь · МСК-42 · СК-63 зона 4 · WGS-84</small></div></div><span id="net" class="status">${navigator.onLine ? 'Онлайн' : 'Офлайн'}</span></header>
    <main>
      <section class="hero"><p class="eyebrow">ТОЧНОЕ ПРЕОБРАЗОВАНИЕ</p><h1>${info.title}</h1><p>${info.intro}</p></section>
      <nav aria-label="Выбор преобразования">${(Object.keys(labels) as Mode[]).map(key => `<button class="mode ${mode === key ? 'active' : ''}" data-mode="${key}">${labels[key].title}</button>`).join('')}</nav>
      <section class="panel"><div class="panel-head"><div><h2>Координаты</h2><p>Можно вставить сразу несколько строк из Excel: два значения, разделённые табуляцией, точкой с запятой или запятой.</p></div><div class="actions"><button id="paste" class="secondary">Вставить список</button><button id="clear" class="secondary">Очистить</button><button id="copy" class="primary">Скопировать результат</button></div></div>
      <div class="table-scroll"><table><thead><tr><th>№</th><th>${info.first}</th><th>${info.second}</th><th>${info.out1}</th><th>${info.out2}</th><th></th></tr></thead><tbody>${resultRows}</tbody></table></div>
      <button id="add" class="add">＋ Добавить строку</button></section>
      <section class="note"><h2>О методике</h2><p>Плоские координаты вычисляются в проекции Гаусса—Крюгера на эллипсоиде Красовского 1940. Для WGS-84 применяется 7-параметрическое преобразование Пулково-1942 → WGS-84 из исходной книги. Все расчёты выполняются в браузере, данные никуда не передаются.</p><p><b>Автономный режим:</b> откройте сайт один раз в сети, затем выберите «Установить приложение» в браузере — конвертер и его формулы останутся доступны без интернета.</p></section>
    </main><footer>Версия 1.0 · Проверяйте результат на контрольных точках перед производственным применением.</footer>`
  bind()
}

function bind() {
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.onclick = () => { mode = button.dataset.mode as Mode; render() })
  document.querySelectorAll<HTMLInputElement>('input[data-id]').forEach(input => input.oninput = () => { const row = rows.find(r => r.id === Number(input.dataset.id)); if (row) row[input.dataset.key as 'first' | 'second'] = input.value; render() })
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

window.addEventListener('online', render); window.addEventListener('offline', render)
registerSW({ immediate: true })
render()
