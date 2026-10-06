import type { EntryRow } from '@/data/types'

/**
 * 渣土外运领域逻辑：筛选、迁移、幂等提交、权限、状态流转、环次同步。
 *
 * 单一数据源约定：运输单台账（muck 模块的行）是唯一事实来源。
 * 掘进环次的出土方量清单、各处的滞留车次统计，全部由这份台账推导，
 * 不再各算一遍。存量运输单按旧版字段（中文键、外运时段字符串）读取兼容。
 */

export const MUCK_MODULE = 'muck'
export const RING_MODULE = 'ring'

/** 台账结构版本：迁移补录后打上这个标记，旧版残留标记（abnormal/pending）随之清理。 */
export const MUCK_SCHEMA_VERSION = 2

export const MUCK_STATUSES = ['待装车', '运输中', '已消纳', '已滞留'] as const

/** 外运结论：到了这两个状态就算有结论，要同步到掘进环次的出土方量清单。 */
export const CONCLUDED_STATUSES = ['已消纳', '已滞留']

export const FLEETS = ['渣土一队', '渣土二队'] as const

/** 状态流转规则：动作 → 目标状态 + 允许的前置状态。 */
export const MUCK_ACTIONS: Record<string, { target: string; from: string[] }> = {
  安排装车: { target: '运输中', from: ['待装车'] },
  确认消纳: { target: '已消纳', from: ['运输中'] },
  登记滞留: { target: '已滞留', from: ['待装车', '运输中'] },
}

/**
 * 列表排序优先级（滞留的车次要能先挑出来）：
 * 已滞留 > 待装车 > 运输中 > 已消纳，同级按外运日期倒序、再按运输单号。
 */
const STATUS_PRIORITY: Record<string, number> = {
  已滞留: 0,
  待装车: 1,
  运输中: 2,
  已消纳: 3,
}

export type Actor = {
  name: string
  role: string
  fleet: string
}

/** 三个筛选条件：消纳场所、运输车辆、外运时段。 */
export type MuckFilters = {
  消纳场所?: string
  运输车辆?: string
  外运时段?: string
}

export type MuckInput = {
  运输单号: string
  对应环号: string
  渣土方量: number
  运输车辆: string
  /** 完整时段描述，例如「2026-10-06 早班」；外运日期由它解析，新旧数据同一条规则。 */
  外运时段: string
  消纳场所: string
  押运人员?: string
}

export type FilterDiagnosis = {
  field: string
  value: string
  /** 只保留这一个条件时还能命中多少条。 */
  survivors: number
}

export type MuckStats = {
  今日外运方量: number
  运输中车辆: number
  滞留车次: number
}

export type RingSoilEntry = {
  环号: string
  /** 已消纳车次的方量合计；null 表示该环还没有外运结论，页面回退展示台账原值。 */
  出土方量: number | null
  已消纳车次: number
  滞留车次: number
  最近外运日期: string
}

export type SubmitResult = {
  ok: boolean
  message: string
  rows: EntryRow[]
  id?: number
  created?: boolean
}

// ---------------------------------------------------------------------------
// 基础读取（兼容存量：旧行没有 外运日期/车队/版本，读取时按同一规则兜底）
// ---------------------------------------------------------------------------

/** 从「外运时段」或任意字符串里解析出外运日期（YYYY-MM-DD），解析不到返回空串。 */
export function parseShipDate(value: unknown): string {
  const match = String(value ?? '').match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (!match) return ''
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
}

/** 读取某行的外运日期：优先迁移补录的「外运日期」，存量行回退解析「外运时段」。 */
export function shipDateOf(row: EntryRow): string {
  const recorded = String(row['外运日期'] ?? '').trim()
  return parseShipDate(recorded) || parseShipDate(row['外运时段'])
}

/** 读取渣土方量：存量行里可能是字符串，统一按数值读。 */
export function volumeOf(row: EntryRow): number {
  const parsed = Number(row['渣土方量'])
  return Number.isFinite(parsed) ? parsed : 0
}

/** 运输车辆归属车队：按车牌尾号奇偶稳定划分，迁移补录和权限判断用同一条规则。 */
export function fleetForVehicle(plate: string): string {
  const text = String(plate ?? '')
  const tail = text.match(/(\d)\s*$/)
  const odd = tail
    ? Number(tail[1]) % 2 === 1
    : [...text].reduce((sum, ch) => sum + (ch.codePointAt(0) ?? 0), 0) % 2 === 1
  return odd ? FLEETS[0] : FLEETS[1]
}

/** 读取所属车队：迁移后的行直接读，存量行按车辆推导。 */
export function fleetOf(row: EntryRow): string {
  const recorded = String(row['车队'] ?? '').trim()
  return recorded || fleetForVehicle(String(row['运输车辆'] ?? ''))
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

// ---------------------------------------------------------------------------
// 存量迁移：按外运日期迁移补录
// ---------------------------------------------------------------------------

function normalizeMuckRow(raw: EntryRow): EntryRow {
  const row = { ...raw }
  const 单号 = String(row['运输单号'] ?? '').trim()
  row['运输单号'] = 单号 || `MUCK-LEGACY-${row.id}`
  row['外运日期'] = shipDateOf(row)
  row['车队'] = fleetOf(row)
  row['版本'] = MUCK_SCHEMA_VERSION
  const status = String(row.status ?? '')
  // 清掉上一版残留的标记，按当前口径重算
  row.pending = !CONCLUDED_STATUSES.includes(status)
  row.abnormal = false
  return row
}

/** 同一运输单号留一条：外运日期新的优先，其次 id 大的（后登记的）。 */
function pickLater(a: EntryRow, b: EntryRow): EntryRow {
  const byDate = shipDateOf(a).localeCompare(shipDateOf(b))
  if (byDate !== 0) return byDate > 0 ? a : b
  return Number(a.id) >= Number(b.id) ? a : b
}

/**
 * 迁移存量运输单：补录外运日期/车队/版本，合并重复运输单号，清掉上一版残留标记。
 * 幂等：迁移过的数据再跑一遍 changed=false。
 */
export function migrateMuckRows(rows: EntryRow[]): { rows: EntryRow[]; changed: boolean } {
  const kept = new Map<string, EntryRow>()
  const order: string[] = []
  for (const raw of rows) {
    const normalized = normalizeMuckRow(raw)
    const key = String(normalized['运输单号'])
    const existing = kept.get(key)
    if (!existing) {
      kept.set(key, normalized)
      order.push(key)
    } else {
      kept.set(key, pickLater(existing, normalized))
    }
  }
  const migrated = order.map((key) => kept.get(key)!)
  const changed = JSON.stringify(migrated) !== JSON.stringify(rows)
  return { rows: migrated, changed }
}

// ---------------------------------------------------------------------------
// 筛选：几个条件按交集过滤；一条都命中不了时指出是哪个条件卡住了
// ---------------------------------------------------------------------------

export function activeFilters(filters: MuckFilters): [keyof MuckFilters, string][] {
  return (Object.entries(filters) as [keyof MuckFilters, string][]).filter(
    ([, value]) => String(value ?? '').trim() !== '',
  )
}

function matchCondition(row: EntryRow, field: keyof MuckFilters, value: string): boolean {
  const wanted = value.trim()
  if (field === '外运时段') {
    const wantedDate = parseShipDate(wanted)
    return wantedDate !== '' && shipDateOf(row) === wantedDate
  }
  return String(row[field] ?? '').trim() === wanted
}

/** 交集过滤：所有非空条件同时满足才命中。 */
export function filterMuckRows(rows: EntryRow[], filters: MuckFilters): EntryRow[] {
  const pairs = activeFilters(filters)
  if (pairs.length === 0) return rows
  return rows.filter((row) => pairs.every(([field, value]) => matchCondition(row, field, value)))
}

/** 空结果诊断：逐个条件统计单独命中数，survivors=0 的就是卡住的条件。 */
export function diagnoseEmptyFilter(rows: EntryRow[], filters: MuckFilters): FilterDiagnosis[] {
  return activeFilters(filters).map(([field, value]) => ({
    field,
    value: value.trim(),
    survivors: rows.filter((row) => matchCondition(row, field, value)).length,
  }))
}

// ---------------------------------------------------------------------------
// 排序与分页
// ---------------------------------------------------------------------------

export function sortMuckRows(rows: EntryRow[]): EntryRow[] {
  return [...rows].sort(
    (a, b) =>
      (STATUS_PRIORITY[String(a.status)] ?? 9) - (STATUS_PRIORITY[String(b.status)] ?? 9) ||
      shipDateOf(b).localeCompare(shipDateOf(a)) ||
      String(a['运输单号']).localeCompare(String(b['运输单号'])),
  )
}

export function paginate<T>(
  items: T[],
  page: number,
  size: number,
): { items: T[]; total: number; page: number; size: number; pageCount: number } {
  const total = items.length
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, size)))
  const current = Math.min(Math.max(1, page), pageCount)
  return {
    items: items.slice((current - 1) * size, current * size),
    total,
    page: current,
    size,
    pageCount,
  }
}

// ---------------------------------------------------------------------------
// 统计：列表、详情、环次清单都用这一份口径
// ---------------------------------------------------------------------------

export function countRetained(rows: EntryRow[]): number {
  return rows.filter((row) => String(row.status) === '已滞留').length
}

export function selectMuckStats(rows: EntryRow[], today: string): MuckStats {
  const shippedToday = rows.filter(
    (row) =>
      shipDateOf(row) === today && ['运输中', '已消纳'].includes(String(row.status)),
  )
  return {
    今日外运方量: round1(shippedToday.reduce((sum, row) => sum + volumeOf(row), 0)),
    运输中车辆: new Set(
      rows.filter((row) => String(row.status) === '运输中').map((row) => String(row['运输车辆'])),
    ).size,
    滞留车次: countRetained(rows),
  }
}

// ---------------------------------------------------------------------------
// 环次同步：外运结论 → 掘进环次的出土方量清单
// ---------------------------------------------------------------------------

/** 由运输单台账推导每个环号的外运清单（唯一口径，页面只读展示）。 */
export function deriveRingSoil(muckRows: EntryRow[], ringRows: EntryRow[]): RingSoilEntry[] {
  const byRing = new Map<string, EntryRow[]>()
  for (const order of muckRows) {
    const ring = String(order['对应环号'] ?? '').trim()
    if (!ring) continue
    const list = byRing.get(ring) ?? []
    list.push(order)
    byRing.set(ring, list)
  }
  return ringRows.map((ring) => {
    const 环号 = String(ring['环号'] ?? '').trim() || `环#${ring.id}`
    const orders = byRing.get(环号) ?? []
    const done = orders.filter((order) => String(order.status) === '已消纳')
    return {
      环号,
      出土方量: done.length ? round1(done.reduce((sum, order) => sum + volumeOf(order), 0)) : null,
      已消纳车次: done.length,
      滞留车次: orders.filter((order) => String(order.status) === '已滞留').length,
      最近外运日期: orders.map(shipDateOf).sort().pop() ?? '',
    }
  })
}

/**
 * 把推导结果回写进环次行，兼容存量的读取方式（旧代码直接读 ring 行的「出土方量」）。
 * 没有外运结论的环号保留台账原值。
 */
export function syncRingRows(muckRows: EntryRow[], ringRows: EntryRow[]): EntryRow[] {
  const manifest = new Map(deriveRingSoil(muckRows, ringRows).map((entry) => [entry.环号, entry]))
  return ringRows.map((ring) => {
    const entry = manifest.get(String(ring['环号'] ?? '').trim())
    if (!entry) return ring
    const next = { ...ring }
    if (entry.出土方量 !== null) next['出土方量'] = String(entry.出土方量)
    next['滞留车次'] = entry.滞留车次
    return next
  })
}

// ---------------------------------------------------------------------------
// 权限：只有本车队的调度能改运输车辆，越权提交一律拦下
// ---------------------------------------------------------------------------

export function canSubmit(actor: Actor): string | null {
  if (actor.role !== '调度') return '只有调度能提交渣土运输单'
  return null
}

export function canEditVehicle(actor: Actor, fleet: string): string | null {
  if (actor.role !== '调度') return '只有调度能改运输车辆'
  if (actor.fleet !== fleet) return `运输车辆属于${fleet}，只有本车队调度能改`
  return null
}

// ---------------------------------------------------------------------------
// 提交（幂等）与状态流转
// ---------------------------------------------------------------------------

function fail(message: string, rows: EntryRow[]): SubmitResult {
  return { ok: false, message, rows }
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

const EDITABLE_FIELDS = ['对应环号', '渣土方量', '运输车辆', '外运时段', '消纳场所', '押运人员']

/**
 * 登记/修改运输单：同一运输单号重复提交只留一条（原地更新，不新增、不翻倍）。
 * 新建或改动运输车辆时必须本车队调度；已消纳的结论是终态，不允许再改。
 */
export function upsertMuckOrder(rows: EntryRow[], input: MuckInput, actor: Actor): SubmitResult {
  const denied = canSubmit(actor)
  if (denied) return fail(denied, rows)

  const 单号 = input.运输单号.trim()
  if (!单号) return fail('运输单号不能为空', rows)
  const 外运日期 = parseShipDate(input.外运时段)
  if (!外运日期) return fail('外运时段里要有明确日期（YYYY-MM-DD）', rows)
  if (!input.对应环号.trim()) return fail('对应环号不能为空', rows)
  if (!(Number(input.渣土方量) > 0)) return fail('渣土方量要大于 0', rows)
  if (!input.运输车辆.trim()) return fail('运输车辆不能为空', rows)
  if (!input.消纳场所.trim()) return fail('消纳场所不能为空', rows)

  const existing = rows.find((row) => String(row['运输单号']).trim() === 单号)
  const fleet = existing ? fleetOf(existing) : actor.fleet
  const vehicleChanged =
    !existing || String(existing['运输车辆']).trim() !== input.运输车辆.trim()
  if (vehicleChanged) {
    const deniedVehicle = canEditVehicle(actor, fleet)
    if (deniedVehicle) return fail(deniedVehicle, rows)
  }
  if (existing && String(existing.status) === '已消纳') {
    return fail(`运输单 ${单号} 已消纳，结论不能改动`, rows)
  }

  if (existing) {
    const updated: EntryRow = {
      ...existing,
      对应环号: input.对应环号.trim(),
      渣土方量: input.渣土方量,
      运输车辆: input.运输车辆.trim(),
      外运时段: input.外运时段.trim(),
      外运日期,
      消纳场所: input.消纳场所.trim(),
      押运人员: (input.押运人员 ?? '').trim(),
      车队: fleet,
      版本: MUCK_SCHEMA_VERSION,
    }
    const unchanged = EDITABLE_FIELDS.every(
      (field) => String(updated[field]) === String(existing[field]),
    )
    if (unchanged) {
      return { ok: true, message: `运输单 ${单号} 与台账一致，未产生新记录`, rows, id: Number(existing.id), created: false }
    }
    return {
      ok: true,
      message: `运输单 ${单号} 已更新（同一运输单只留一条）`,
      rows: rows.map((row) => (row.id === existing.id ? updated : row)),
      id: Number(existing.id),
      created: false,
    }
  }

  const id = nextId(rows)
  const row: EntryRow = {
    id,
    status: '待装车',
    pending: true,
    abnormal: false,
    运输单号: 单号,
    对应环号: input.对应环号.trim(),
    渣土方量: input.渣土方量,
    运输车辆: input.运输车辆.trim(),
    外运时段: input.外运时段.trim(),
    外运日期,
    消纳场所: input.消纳场所.trim(),
    押运人员: (input.押运人员 ?? '').trim(),
    车队: actor.fleet,
    版本: MUCK_SCHEMA_VERSION,
  }
  return { ok: true, message: `运输单 ${单号} 已登记`, rows: [...rows, row], id, created: true }
}

/** 状态流转：重复同一动作是幂等空操作；结论状态（已消纳/已滞留）不可再流转。 */
export function transitionMuckRow(
  rows: EntryRow[],
  id: number,
  action: string,
  actor: Actor,
): SubmitResult {
  const denied = canSubmit(actor)
  if (denied) return fail(denied, rows)
  const spec = MUCK_ACTIONS[action]
  if (!spec) return fail(`没有登记「${action}」这个动作`, rows)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return fail(`没有找到编号为 ${id} 的渣土运输单`, rows)
  const current = String(rows[index].status)
  if (current === spec.target) {
    return { ok: true, message: `运输单已是「${spec.target}」，重复操作不生效`, rows, id }
  }
  if (!spec.from.includes(current)) {
    return fail(`「${current}」状态不能${action}`, rows)
  }
  const updated: EntryRow = {
    ...rows[index],
    status: spec.target,
    pending: !CONCLUDED_STATUSES.includes(spec.target),
    abnormal: false,
  }
  const next = [...rows]
  next[index] = updated
  return { ok: true, message: `已${action}，当前状态「${spec.target}」`, rows: next, id }
}
