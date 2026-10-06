import {
  MUCK_MODULE,
  RING_MODULE,
  countRetained,
  deriveRingSoil,
  diagnoseEmptyFilter,
  filterMuckRows,
  migrateMuckRows,
  paginate,
  selectMuckStats,
  sortMuckRows,
  syncRingRows,
  transitionMuckRow,
  upsertMuckOrder,
} from '@/domain/muck'
import type {
  Actor,
  FilterDiagnosis,
  MuckFilters,
  MuckStats,
  RingSoilEntry,
} from '@/domain/muck'
import { listRows, transact } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

/**
 * 渣土外运服务层：页面只调这里。筛选条件、台账、环次清单都从这同一份数据推导，
 * 不再出现「取条件的那份和登记的那份各算一遍」。
 */

export class MuckLoadError extends Error {}

export type MuckListResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
  pageCount: number
  /** 空结果时的诊断：哪个条件卡住了。 */
  diagnoses: FilterDiagnosis[]
  stats: MuckStats
  /** 各状态条数（全量口径，不随分页变）。 */
  statusCounts: Record<string, number>
  /** 下拉用的可选项，从当前台账里取。 */
  choices: { 消纳场所: string[]; 运输车辆: string[] }
}

function todayString(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function distinct(rows: EntryRow[], field: string): string[] {
  return [...new Set(rows.map((row) => String(row[field] ?? '').trim()).filter(Boolean))].sort()
}

/**
 * 存量运输单按外运日期迁移补录：补 外运日期/车队/版本，合并重复运输单，清掉上一版残留标记。
 * 幂等。读取时总是返回迁移后的视图；落库尽力而为——写不进去不挡读取，
 * 真正的写入（提交/流转）失败才会报「整套撤回」。
 */
export function ensureMuckMigrated(): void {
  readMuckRows()
}

function readMuckRows(): EntryRow[] {
  let raw: EntryRow[]
  try {
    raw = listRows(MUCK_MODULE)
  } catch {
    throw new MuckLoadError('渣土外运台账读取失败，请重试')
  }
  if (!Array.isArray(raw)) {
    throw new MuckLoadError('渣土外运台账读取失败：数据形态不对')
  }
  const { rows, changed } = migrateMuckRows(raw)
  if (changed) {
    try {
      transact((draft) => {
        draft[MUCK_MODULE] = rows
        draft[RING_MODULE] = syncRingRows(rows, draft[RING_MODULE] ?? [])
      })
    } catch {
      // 迁移落库失败：本次读取仍用迁移后的视图，台账保持原样，下次读取再试
    }
  }
  return rows
}

export function listMuck(filters: MuckFilters, page: number, size: number): MuckListResult {
  let all: EntryRow[]
  try {
    all = readMuckRows()
  } catch (error) {
    if (error instanceof MuckLoadError) throw error
    throw new MuckLoadError('渣土外运台账读取失败，请重试')
  }
  const matched = filterMuckRows(sortMuckRows(all), filters)
  const paged = paginate(matched, page, size)
  const statusCounts: Record<string, number> = {}
  for (const row of all) {
    const status = String(row.status)
    statusCounts[status] = (statusCounts[status] ?? 0) + 1
  }
  return {
    ...paged,
    diagnoses: matched.length === 0 ? diagnoseEmptyFilter(all, filters) : [],
    stats: selectMuckStats(all, todayString()),
    statusCounts,
    choices: { 消纳场所: distinct(all, '消纳场所'), 运输车辆: distinct(all, '运输车辆') },
  }
}

/** 详情入口：与列表读同一份台账、同一个统计口径，滞留车次两边必然对得上。 */
export function getMuckOrder(id: number): { order: EntryRow; stats: MuckStats } {
  const all = readMuckRows()
  const order = all.find((row) => Number(row.id) === id)
  if (!order) {
    throw new MuckLoadError(`没有找到编号为 ${id} 的渣土运输单`)
  }
  return { order, stats: selectMuckStats(all, todayString()) }
}

/** 提交（登记/修改）：幂等 + 权限校验在领域层；这里负责把运输单与环次同步整套落库，失败整套撤回。 */
export function submitMuck(
  input: Parameters<typeof upsertMuckOrder>[1],
  actor: Actor,
): ActionResult & { id?: number; created?: boolean } {
  const result = upsertMuckOrder(readMuckRows(), input, actor)
  if (!result.ok) return result
  try {
    transact((draft) => {
      draft[MUCK_MODULE] = result.rows
      draft[RING_MODULE] = syncRingRows(result.rows, draft[RING_MODULE] ?? [])
    })
  } catch {
    return { ok: false, message: '落库失败，本次提交已整套撤回，台账未变' }
  }
  return result
}

/** 状态流转：外运结论（已消纳/已滞留）在同一个事务里同步到掘进环次。 */
export function transitionMuck(id: number, action: string, actor: Actor): ActionResult {
  const result = transitionMuckRow(readMuckRows(), id, action, actor)
  if (!result.ok) return result
  try {
    transact((draft) => {
      draft[MUCK_MODULE] = result.rows
      draft[RING_MODULE] = syncRingRows(result.rows, draft[RING_MODULE] ?? [])
    })
  } catch {
    return { ok: false, message: '落库失败，本次操作已整套撤回，台账未变' }
  }
  return result
}

/** 掘进环次的出土方量清单：由运输单台账推导，与渣土外运页读到的是同一份。 */
export function ringSoilManifest(): RingSoilEntry[] {
  return deriveRingSoil(readMuckRows(), listRows(RING_MODULE))
}

/** 滞留车次：列表、详情、环次清单共用一个口径。 */
export function retainedTripCount(): number {
  return countRetained(readMuckRows())
}

/** 登记表单里的环号选项，取自掘进环次台账。 */
export function listRingOptions(): string[] {
  return listRows(RING_MODULE)
    .map((row) => String(row['环号'] ?? '').trim())
    .filter(Boolean)
}
