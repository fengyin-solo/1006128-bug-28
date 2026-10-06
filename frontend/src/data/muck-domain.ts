/**
 * 渣土外运唯一取数口径（single source of truth）。
 *
 * 背景：原先「取条件的那份」（列表/筛选）和「登记的那份」（动作流转、统计）各自从
 * localStorage 算一遍，导致滞留车次两处对不上、台账残留上一版标记、条件互相覆盖等问题。
 * 现在列表、详情、掘进环次出土方量清单、看板统计、存量的 listEntries('muck') 全部只认
 * 本文件；登记/流转也只走本文件，落库为原子提交，失败即整套撤回。
 */
import { listRows, reloadStorage, replaceRowsAtomic } from './local-store'
import { SEED_ROWS } from './seed'
import type { EntryRow, FilterDiagnostic, PageResult } from './types'

export const MUCK_KEY = 'muck'
export const SCHEMA_MARK = '__schema'
export const SCHEMA_VERSION = 2

export type MuckStatus = '待装车' | '运输中' | '已消纳' | '已滞留'

export const MUCK_STATUSES: MuckStatus[] = ['待装车', '运输中', '已消纳', '已滞留']

export type MuckOrder = {
  id: number
  运输单号: string
  对应环号: string
  渣土方量: number
  运输车辆: string
  外运日期: string
  外运时段: string
  消纳场所: string
  押运人员: string
  归属车队: string
  滞留原因: string
  登记时间: string
  status: MuckStatus
  pending: boolean
  abnormal: boolean
}

export type MuckFilter = {
  消纳场所?: string
  运输车辆?: string
  外运开始?: string
  外运结束?: string
  仅滞留?: boolean
}

export type MuckQueryResult = {
  items: MuckOrder[]
  total: number
  page: number
  size: number
  diagnostics: FilterDiagnostic[]
}

export type RingMuckSummary = {
  环号: string
  外运车次: number
  已消纳车次: number
  滞留车次: number
  /** 以运输单为准汇总的出土方量（只计已消纳与运输中，待装车/已滞留未到场不结算）。 */
  运输单方量: number
  滞留: MuckOrder[]
}

export type MuckStats = {
  /** 当日（无当日数据时取台账最新外运日期）已消纳方量。 */
  今日外运方量: number
  统计日期: string
  /** 运输中的去重车辆数。 */
  运输中车辆: number
  滞留车次: number
  待装车: number
  运输中: number
  已消纳: number
  已滞留: number
}

export type Identity = { role: 'dispatcher' | 'manager' | 'viewer'; fleet: string }

export type WriteResult =
  | { ok: true; message: string; order: MuckOrder; duplicated?: boolean }
  | { ok: false; message: string }

/* ---------------------------------- 车辆台账 ---------------------------------- */

/** 车辆与车队的归属表：改派/登记车辆时据此判定本车队权限，兼容存量补录。 */
export const VEHICLE_FLEET: Record<string, string> = {
  '沪A·D101': '一队',
  '沪A·D102': '一队',
  '沪A·D103': '一队',
  '沪B·D201': '二队',
  '沪B·D202': '二队',
  '沪B·D203': '二队',
}

export function fleetOfVehicle(vehicle: string, fallback = '一队'): string {
  return VEHICLE_FLEET[vehicle.trim()] ?? fallback
}

/* ---------------------------------- 故障注入 ---------------------------------- */
// 纯前端无法真正制造网络故障；开关用于演示「取数失败可重试、不沿用上一轮结果」
// 以及「落库失败整套撤回」。页面页脚提供开关，不写入任何业务数据。
let readFailure = false
let writeFailure = false

export function setReadFailure(on: boolean): void {
  readFailure = on
}
export function setWriteFailure(on: boolean): void {
  writeFailure = on
}
export function failureState(): { read: boolean; write: boolean } {
  return { read: readFailure, write: writeFailure }
}

/* ----------------------------- 存量迁移与规范化 ------------------------------ */

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  const parsed = Number(String(value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : 0
}

function isMuckStatus(value: unknown): value is MuckStatus {
  return MUCK_STATUSES.includes(value as MuckStatus)
}

/** 从外运时段/日期里挑出 YYYY-MM-DD，存量单没有外运日期时据此迁移补录。 */
function extractDate(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const text = String(candidate ?? '')
    const match = text.match(/\d{4}-\d{2}-\d{2}/)
    if (match) {
      return match[0]
    }
  }
  return ''
}

/** 存量运输单规范化：补外运日期、归属车队，重算 pending/abnormal，清掉上一版残留标记。 */
export function normalizeOrder(row: EntryRow, index: number): MuckOrder {
  const status: MuckStatus = isMuckStatus(row.status)
    ? row.status
    : isMuckStatus(row['运输状态'])
      ? (row['运输状态'] as MuckStatus)
      : '待装车'
  const vehicle = String(row['运输车辆'] ?? '').trim()
  const fleet = String(row['归属车队'] ?? '').trim() || fleetOfVehicle(vehicle)
  const date = extractDate(row['外运日期'], row['外运时段'])
  return {
    id: Number(row.id) || index + 1,
    运输单号: String(row['运输单号'] ?? `YD-LEGACY-${Number(row.id) || index + 1}`),
    对应环号: String(row['对应环号'] ?? ''),
    渣土方量: toNumber(row['渣土方量']),
    运输车辆: vehicle,
    外运日期: date,
    外运时段: String(row['外运时段'] ?? (date ? date : '')),
    消纳场所: String(row['消纳场所'] ?? ''),
    押运人员: String(row['押运人员'] ?? ''),
    归属车队: fleet,
    滞留原因: String(row['滞留原因'] ?? ''),
    登记时间: String(row['登记时间'] ?? (date ? `${date} 00:00` : '')),
    status,
    pending: status !== '已消纳',
    abnormal: status === '已滞留',
  }
}

function isCanonical(row: EntryRow): boolean {
  return row[SCHEMA_MARK] === SCHEMA_VERSION
}

function toEntryRow(order: MuckOrder): EntryRow {
  return { ...order, [SCHEMA_MARK]: SCHEMA_VERSION }
}

/** 读取并按需迁移全部运输单；只认这一份，读失败直接抛出，不返回上一轮缓存。 */
export function loadOrders(): MuckOrder[] {
  if (readFailure) {
    throw new Error('渣土外运台账取数失败（已开启取数故障模拟），请重试')
  }
  // 每次都重新走存储层，保证重试时真的重新取数，而不是顶用上一轮结果。
  const rows = reloadStorage()[MUCK_KEY] ?? listRows(MUCK_KEY)
  if (rows.some(isCanonical)) {
    return rows.filter(isCanonical).map((row, index) => normalizeOrder(row, index))
  }
  // 存量版本：迁移补录后原子回写（本函数只读，回写放到 ensurePersisted）。
  const orders = rows.map((row, index) => normalizeOrder(row, index))
  persistOrders(orders)
  return orders
}

/** 首次播种用：供没有任何存量数据时生成规范运输单。 */
export function seedOrders(): MuckOrder[] {
  return SEED_ROWS[MUCK_KEY].map((row, index) => normalizeOrder(row, index))
}

function persistOrders(orders: MuckOrder[]): void {
  if (writeFailure) {
    throw new Error('台账落库失败（已开启落库故障模拟），本次提交已整套撤回')
  }
  replaceRowsAtomic(MUCK_KEY, orders.map(toEntryRow))
}

/* ---------------------------------- 筛选定位 ---------------------------------- */

type ActiveCondition = {
  key: string
  label: string
  value: string
  test: (order: MuckOrder) => boolean
}

function buildConditions(filter: MuckFilter): ActiveCondition[] {
  const conditions: ActiveCondition[] = []
  const site = filter.消纳场所?.trim()
  if (site) {
    conditions.push({
      key: '消纳场所',
      label: '消纳场所',
      value: site,
      test: (order) => order.消纳场所.includes(site),
    })
  }
  const vehicle = filter.运输车辆?.trim()
  if (vehicle) {
    conditions.push({
      key: '运输车辆',
      label: '运输车辆',
      value: vehicle,
      test: (order) => order.运输车辆.includes(vehicle),
    })
  }
  const start = filter.外运开始
  const end = filter.外运结束
  if (start || end) {
    conditions.push({
      key: '外运时段',
      label: '外运时段',
      value: `${start || '最早'} ~ ${end || '最新'}`,
      test: (order) => {
        if (!order.外运日期) {
          return false
        }
        if (start && order.外运日期 < start) {
          return false
        }
        if (end && order.外运日期 > end) {
          return false
        }
        return true
      },
    })
  }
  if (filter.仅滞留) {
    conditions.push({
      key: '仅滞留',
      label: '状态',
      value: '已滞留',
      test: (order) => order.status === '已滞留',
    })
  }
  return conditions
}

/**
 * 交集过滤：消纳场所、运输车辆、外运时段同时生效，互不覆盖。
 * 同时给每个条件单独算一次命中数，一条都没有时能说清是哪一格卡住的。
 */
export function queryOrders(filter: MuckFilter = {}, page = 1, size = 8): MuckQueryResult {
  const all = loadOrders()
  const conditions = buildConditions(filter)
  const diagnostics: FilterDiagnostic[] = conditions.map((condition) => ({
    field: condition.key,
    label: condition.label,
    value: condition.value,
    matched: all.filter(condition.test).length,
    blocked: all.filter(condition.test).length === 0,
  }))
  const matched = all.filter((order) => conditions.every((condition) => condition.test(order)))
  const sorted = [...matched].sort(compareOrders)
  const safePage = Math.min(Math.max(1, page), Math.max(1, Math.ceil(sorted.length / size)))
  const startIndex = (safePage - 1) * size
  return {
    items: sorted.slice(startIndex, startIndex + size),
    total: sorted.length,
    page: safePage,
    size,
    diagnostics,
  }
}

/** 滞留车次唯一口径：列表「只看滞留」、详情抽屉、掘进环次清单都调它。 */
export function detainedOrders(filter: MuckFilter = {}): MuckOrder[] {
  return queryOrders({ ...filter, 仅滞留: true }, 1, Number.MAX_SAFE_INTEGER).items
}

export function getOrder(id: number): MuckOrder | undefined {
  return loadOrders().find((order) => order.id === id)
}

function compareOrders(a: MuckOrder, b: MuckOrder): number {
  if (a.外运日期 !== b.外运日期) {
    return b.外运日期.localeCompare(a.外运日期)
  }
  return b.id - a.id
}

/* ---------------------------------- 统计口径 ---------------------------------- */

function resolveStatsDate(orders: MuckOrder[]): string {
  const today = new Date().toISOString().slice(0, 10)
  if (orders.some((order) => order.外运日期 === today)) {
    return today
  }
  const dates = orders.map((order) => order.外运日期).filter(Boolean).sort()
  return dates[dates.length - 1] ?? today
}

export function muckStats(): MuckStats {
  const orders = loadOrders()
  const date = resolveStatsDate(orders)
  const byStatus = (status: MuckStatus) => orders.filter((order) => order.status === status)
  return {
    统计日期: date,
    今日外运方量: byStatus('已消纳')
      .filter((order) => order.外运日期 === date)
      .reduce((sum, order) => sum + order.渣土方量, 0),
    运输中车辆: new Set(byStatus('运输中').map((order) => order.运输车辆)).size,
    滞留车次: byStatus('已滞留').length,
    待装车: byStatus('待装车').length,
    运输中: byStatus('运输中').length,
    已消纳: byStatus('已消纳').length,
    已滞留: byStatus('已滞留').length,
  }
}

/**
 * 掘进环次出土方量清单：结论以运输单为准（现场登记的方量是实际外运结算值）。
 * 没有任何运输单的环次不在本清单内，由页面回退到环次台账存量字段，兼容旧读取方式。
 */
export function ringMuckSummaries(): RingMuckSummary[] {
  const orders = loadOrders()
  const byRing = new Map<string, MuckOrder[]>()
  for (const order of orders) {
    if (!order.对应环号) {
      continue
    }
    const list = byRing.get(order.对应环号) ?? []
    list.push(order)
    byRing.set(order.对应环号, list)
  }
  return [...byRing.keys()]
    .sort()
    .map((ring) => {
      const list = byRing.get(ring)!
      return {
        环号: ring,
        外运车次: list.length,
        已消纳车次: list.filter((order) => order.status === '已消纳').length,
        滞留车次: list.filter((order) => order.status === '已滞留').length,
        运输单方量: list
          .filter((order) => order.status === '已消纳' || order.status === '运输中')
          .reduce((sum, order) => sum + order.渣土方量, 0),
        滞留: list.filter((order) => order.status === '已滞留').sort(compareOrders),
      }
    })
}

/* ---------------------------------- 登记与流转 ---------------------------------- */

export type CreateOrderInput = {
  运输单号: string
  对应环号?: string
  渣土方量: number
  运输车辆: string
  外运日期: string
  外运时段: string
  消纳场所: string
  押运人员?: string
}

/** 车辆类字段（登记时指派、改派）只允许本车队调度操作；越权一律拦下。 */
export function canAssignVehicle(identity: Identity, targetFleet: string): boolean {
  return identity.role === 'dispatcher' && identity.fleet === targetFleet
}

function nextId(orders: MuckOrder[]): number {
  return orders.reduce((max, order) => Math.max(max, order.id), 0) + 1
}

function nowText(): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/**
 * 登记运输单。同一运输单号重复提交只留一条（幂等，再交一遍不会翻倍）。
 * 校验顺序：必填/数值 → 车辆权限（越权直接拦下，不进落库）→ 查重 → 原子落库。
 */
export function createOrder(input: CreateOrderInput, identity: Identity): WriteResult {
  const code = input.运输单号.trim()
  const vehicle = input.运输车辆.trim()
  const site = input.消纳场所.trim()
  if (!code) {
    return { ok: false, message: '运输单号为必填项' }
  }
  if (!vehicle) {
    return { ok: false, message: '运输车辆为必填项' }
  }
  if (!input.外运日期) {
    return { ok: false, message: '外运日期为必填项' }
  }
  if (!site) {
    return { ok: false, message: '消纳场所为必填项' }
  }
  if (!Number.isFinite(input.渣土方量) || input.渣土方量 < 0) {
    return { ok: false, message: '渣土方量必须是不小于 0 的数字' }
  }
  const targetFleet = fleetOfVehicle(vehicle)
  if (!canAssignVehicle(identity, targetFleet)) {
    return {
      ok: false,
      message: `越权拦截：运输车辆「${vehicle}」归${targetFleet}，只有${targetFleet}调度能指派，当前身份为「${identity.role === 'dispatcher' ? `${identity.fleet}调度` : identity.role}」`,
    }
  }

  const orders = loadOrders()
  const existing = orders.find((order) => order.运输单号 === code)
  if (existing) {
    // 幂等：重复提交原样返回已存在那一条，不会产生第二条。
    return { ok: true, duplicated: true, message: `运输单 ${code} 已登记，重复提交未重复建单`, order: existing }
  }

  const order: MuckOrder = {
    id: nextId(orders),
    运输单号: code,
    对应环号: input.对应环号?.trim() ?? '',
    渣土方量: input.渣土方量,
    运输车辆: vehicle,
    外运日期: input.外运日期,
    外运时段: input.外运时段 || input.外运日期,
    消纳场所: site,
    押运人员: input.押运人员?.trim() ?? '',
    归属车队: targetFleet,
    滞留原因: '',
    登记时间: nowText(),
    status: '待装车',
    pending: true,
    abnormal: false,
  }

  try {
    persistOrders([...orders, order])
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '台账落库失败，已整套撤回' }
  }
  return { ok: true, message: `运输单 ${code} 登记成功`, order }
}

const TRANSITION_TARGET: Record<string, MuckStatus> = {
  安排装车: '运输中',
  确认消纳: '已消纳',
}

function applyStatus(order: MuckOrder, status: MuckStatus, reason = ''): MuckOrder {
  return {
    ...order,
    status,
    pending: status !== '已消纳',
    abnormal: status === '已滞留',
    滞留原因: status === '已滞留' ? reason || order.滞留原因 : status === '运输中' ? '' : order.滞留原因,
  }
}

/** 状态流转：安排装车 / 确认消纳 / 登记滞留。落库失败整套撤回。 */
export function transitionOrder(id: number, action: string, reason = ''): WriteResult {
  const orders = loadOrders()
  const index = orders.findIndex((order) => order.id === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的运输单` }
  }
  const current = orders[index]
  if (action === '登记滞留') {
    if (current.status === '已滞留') {
      return { ok: false, message: '该运输单已滞留，不用重复登记' }
    }
  } else {
    const target = TRANSITION_TARGET[action]
    if (!target) {
      return { ok: false, message: `运输单没有登记「${action}」这个动作` }
    }
    if (current.status === target) {
      return { ok: false, message: `运输单已经是「${target}」，不用重复操作` }
    }
  }
  const updated = applyStatus(current, action === '登记滞留' ? '已滞留' : TRANSITION_TARGET[action], reason)
  const next = [...orders]
  next[index] = updated
  try {
    persistOrders(next)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '台账落库失败，已整套撤回' }
  }
  return { ok: true, message: `运输单已${action}，当前状态「${updated.status}」`, order: updated }
}

/**
 * 改派运输车辆：只有该单当前所属车队的调度能改，越权一律拦下。
 * （改派仍在本车队内部车辆间进行；跨车队改派需对方车队调度操作。）
 */
export function reassignVehicle(id: number, vehicle: string, identity: Identity): WriteResult {
  const nextVehicle = vehicle.trim()
  if (!nextVehicle) {
    return { ok: false, message: '运输车辆不能为空' }
  }
  const orders = loadOrders()
  const index = orders.findIndex((order) => order.id === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的运输单` }
  }
  const current = orders[index]
  const targetFleet = fleetOfVehicle(nextVehicle)
  if (!canAssignVehicle(identity, current.归属车队) || targetFleet !== current.归属车队) {
    const reason =
      targetFleet !== current.归属车队
        ? `目标车辆「${nextVehicle}」归${targetFleet}，跨车队改派被拦下`
        : `只有${current.归属车队}调度能改本车队运输单的车辆`
    return { ok: false, message: `越权拦截：${reason}` }
  }
  if (nextVehicle === current.运输车辆) {
    return { ok: false, message: '运输车辆没有变化' }
  }
  const updated: MuckOrder = { ...current, 运输车辆: nextVehicle }
  const next = [...orders]
  next[index] = updated
  try {
    persistOrders(next)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '台账落库失败，已整套撤回' }
  }
  return { ok: true, message: `运输单 ${current.运输单号} 的车辆已改为「${nextVehicle}」`, order: updated }
}

/* --------------------------- 兼容存量 listEntries ---------------------------- */

/**
 * 兼容旧的本地服务读法：消纳场所/运输车辆按包含匹配，外运时段按日期区间，
 * 全部走交集，和页面是同一份数据、同一套结论。
 */
export function queryAsPageResult(
  filters: Record<string, string>,
  page = 1,
  size = Number.MAX_SAFE_INTEGER,
): PageResult {
  const result = queryOrders(
    {
      消纳场所: filters['消纳场所'],
      运输车辆: filters['运输车辆'],
      外运开始: filters['外运开始'] ?? extractDate(filters['外运时段']),
      外运结束: filters['外运结束'] ?? extractDate(filters['外运时段']),
    },
    page,
    size,
  )
  return {
    items: result.items.map(toEntryRow),
    total: result.total,
    page: result.page,
    size: result.size,
    diagnostics: result.diagnostics,
  }
}

/** 供导出等仍需要 EntryRow 形态的场景使用。 */
export function allEntryRows(): EntryRow[] {
  return loadOrders()
    .slice()
    .sort(compareOrders)
    .map(toEntryRow)
}
