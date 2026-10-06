import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MUCK_SCHEMA_VERSION,
  canEditVehicle,
  countRetained,
  deriveRingSoil,
  diagnoseEmptyFilter,
  filterMuckRows,
  fleetForVehicle,
  migrateMuckRows,
  paginate,
  parseShipDate,
  selectMuckStats,
  shipDateOf,
  sortMuckRows,
  syncRingRows,
  transitionMuckRow,
  upsertMuckOrder,
} from '@/domain/muck'
import type { Actor, MuckInput } from '@/domain/muck'
import type { EntryRow } from '@/data/types'

const dispatcherA: Actor = { name: '调度甲', role: '调度', fleet: '渣土一队' }
const dispatcherB: Actor = { name: '调度乙', role: '调度', fleet: '渣土二队' }
const visitor: Actor = { name: '访客', role: '访客', fleet: '渣土一队' }

function legacyRow(overrides: Partial<EntryRow>): EntryRow {
  return {
    id: 1,
    status: '待装车',
    pending: true,
    abnormal: false,
    运输单号: 'MUCK-0001',
    对应环号: 'R-108',
    渣土方量: '42.5',
    运输车辆: '沪A10231',
    外运时段: '2026-09-28 08:00-10:00',
    消纳场所: '东山消纳场',
    押运人员: '张三',
    ...overrides,
  }
}

function input(overrides: Partial<MuckInput>): MuckInput {
  return {
    运输单号: 'MUCK-1001',
    对应环号: 'R-108',
    渣土方量: 40,
    运输车辆: '沪A10240',
    外运时段: '2026-10-06 早班 08:00-12:00',
    消纳场所: '东山消纳场',
    押运人员: '张三',
    ...overrides,
  }
}

describe('筛选：几个条件按交集过滤', () => {
  const rows = [
    legacyRow({ id: 1, 消纳场所: '东山消纳场', 运输车辆: '沪A10231', 外运时段: '2026-09-28 08:00-10:00' }),
    legacyRow({ id: 2, 消纳场所: '东山消纳场', 运输车辆: '沪A10232', 外运时段: '2026-09-29 08:00-10:00' }),
    legacyRow({ id: 3, 消纳场所: '西洼消纳场', 运输车辆: '沪A10231', 外运时段: '2026-09-29 08:00-10:00' }),
  ]

  it('单个条件过滤', () => {
    expect(filterMuckRows(rows, { 消纳场所: '东山消纳场' })).toHaveLength(2)
    expect(filterMuckRows(rows, { 运输车辆: '沪A10231' })).toHaveLength(2)
    expect(filterMuckRows(rows, { 外运时段: '2026-09-29' })).toHaveLength(2)
  })

  it('多个条件取交集而不是互相覆盖', () => {
    const matched = filterMuckRows(rows, {
      消纳场所: '东山消纳场',
      运输车辆: '沪A10231',
      外运时段: '2026-09-28',
    })
    expect(matched).toHaveLength(1)
    expect(matched[0].id).toBe(1)
  })

  it('空条件不参与过滤', () => {
    expect(filterMuckRows(rows, { 消纳场所: '', 运输车辆: '  ', 外运时段: '' })).toHaveLength(3)
  })

  it('外运时段按外运日期匹配，兼容存量的时段写法', () => {
    expect(filterMuckRows(rows, { 外运时段: '2026-09-28' })).toHaveLength(1)
    expect(shipDateOf(legacyRow({ 外运日期: '2026-10-01', 外运时段: '2026-09-28 08:00-10:00' }))).toBe('2026-10-01')
  })
})

describe('空结果诊断：写清是哪个条件卡住了', () => {
  const rows = [
    legacyRow({ id: 1, 消纳场所: '东山消纳场', 运输车辆: '沪A10231', 外运时段: '2026-09-28 08:00-10:00' }),
    legacyRow({ id: 2, 消纳场所: '西洼消纳场', 运输车辆: '沪A10232', 外运时段: '2026-09-29 08:00-10:00' }),
  ]

  it('某个条件单独就排除全部记录时，指出来', () => {
    const diagnoses = diagnoseEmptyFilter(rows, { 消纳场所: '不存在的场所', 运输车辆: '沪A10231' })
    const blocked = diagnoses.filter((item) => item.survivors === 0)
    expect(blocked).toHaveLength(1)
    expect(blocked[0].field).toBe('消纳场所')
  })

  it('各自有命中但交集为空时，每个条件都给出命中数', () => {
    const diagnoses = diagnoseEmptyFilter(rows, { 消纳场所: '东山消纳场', 运输车辆: '沪A10232' })
    expect(diagnoses.every((item) => item.survivors > 0)).toBe(true)
    expect(filterMuckRows(rows, { 消纳场所: '东山消纳场', 运输车辆: '沪A10232' })).toHaveLength(0)
  })
})

describe('排序与分页', () => {
  it('滞留车次排在最前，再按外运日期倒序', () => {
    const sorted = sortMuckRows([
      legacyRow({ id: 1, status: '已消纳', 外运时段: '2026-09-28 08:00-10:00' }),
      legacyRow({ id: 2, status: '已滞留', 外运时段: '2026-09-27 08:00-10:00' }),
      legacyRow({ id: 3, status: '待装车', 外运时段: '2026-09-29 08:00-10:00' }),
    ])
    expect(sorted.map((row) => row.id)).toEqual([2, 3, 1])
  })

  it('分页切片正确，页码越界时收敛', () => {
    const items = [1, 2, 3, 4, 5, 6, 7]
    expect(paginate(items, 2, 5).items).toEqual([6, 7])
    const clamped = paginate(items, 9, 5)
    expect(clamped.page).toBe(2)
    expect(clamped.total).toBe(7)
  })
})

describe('存量迁移：按外运日期迁移补录', () => {
  it('补录外运日期/车队/版本，清掉上一版残留标记', () => {
    const { rows, changed } = migrateMuckRows([
      legacyRow({ id: 2, status: '运输中', abnormal: true, 外运时段: '2026-09-28 10:00-12:00' }),
    ])
    expect(changed).toBe(true)
    expect(rows[0]['外运日期']).toBe('2026-09-28')
    expect(rows[0]['车队']).toBe(fleetForVehicle('沪A10231'))
    expect(rows[0]['版本']).toBe(MUCK_SCHEMA_VERSION)
    expect(rows[0].abnormal).toBe(false)
    expect(rows[0].pending).toBe(true)
  })

  it('结论状态（已消纳/已滞留）不再是待处理', () => {
    const { rows } = migrateMuckRows([legacyRow({ status: '已消纳', pending: true })])
    expect(rows[0].pending).toBe(false)
  })

  it('同一运输单号只留一条：外运日期新的优先', () => {
    const { rows } = migrateMuckRows([
      legacyRow({ id: 3, 运输单号: 'MUCK-0003', 外运时段: '2026-09-29 08:00-10:00' }),
      legacyRow({ id: 4, 运输单号: 'MUCK-0003', 外运时段: '2026-09-28 08:00-10:00' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(3)
  })

  it('迁移是幂等的', () => {
    const first = migrateMuckRows([legacyRow({ abnormal: true })])
    const second = migrateMuckRows(first.rows)
    expect(second.changed).toBe(false)
    expect(second.rows).toEqual(first.rows)
  })
})

describe('提交：幂等与权限', () => {
  it('同一运输单重复提交只留一条，再交一遍不会翻倍', () => {
    const first = upsertMuckOrder([], input({}), dispatcherA)
    expect(first.ok).toBe(true)
    expect(first.rows).toHaveLength(1)

    const again = upsertMuckOrder(first.rows, input({}), dispatcherA)
    expect(again.ok).toBe(true)
    expect(again.rows).toHaveLength(1)
    expect(again.id).toBe(first.id)
    expect(again.message).toContain('未产生新记录')

    const changed = upsertMuckOrder(first.rows, input({ 渣土方量: 45 }), dispatcherA)
    expect(changed.rows).toHaveLength(1)
    expect(changed.rows[0]['渣土方量']).toBe(45)
    // 统计口径按行算，行数不变就不会翻倍
    expect(selectMuckStats(changed.rows, '2026-10-06').今日外运方量).toBe(0)
  })

  it('非调度提交一律拦下', () => {
    const result = upsertMuckOrder([], input({}), visitor)
    expect(result.ok).toBe(false)
    expect(result.rows).toHaveLength(0)
  })

  it('只有本车队的调度能改运输车辆，越权提交拦下', () => {
    const created = upsertMuckOrder([], input({}), dispatcherA)
    expect(created.rows[0]['车队']).toBe('渣土一队')

    const denied = upsertMuckOrder(created.rows, input({ 运输车辆: '沪B99999' }), dispatcherB)
    expect(denied.ok).toBe(false)
    expect(denied.message).toContain('本车队调度')

    const allowed = upsertMuckOrder(created.rows, input({ 运输车辆: '沪A10241' }), dispatcherA)
    expect(allowed.ok).toBe(true)
    expect(allowed.rows[0]['运输车辆']).toBe('沪A10241')
  })

  it('canEditVehicle 只认本车队调度', () => {
    expect(canEditVehicle(dispatcherA, '渣土一队')).toBeNull()
    expect(canEditVehicle(dispatcherB, '渣土一队')).toContain('渣土一队')
    expect(canEditVehicle(visitor, '渣土一队')).toContain('调度')
  })

  it('已消纳的结论是终态，不能再改', () => {
    const created = upsertMuckOrder([], input({}), dispatcherA)
    const concluded = transitionMuckRow(
      transitionMuckRow(created.rows, Number(created.id), '安排装车', dispatcherA).rows,
      Number(created.id),
      '确认消纳',
      dispatcherA,
    )
    const result = upsertMuckOrder(concluded.rows, input({ 渣土方量: 99 }), dispatcherA)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('已消纳')
  })
})

describe('状态流转', () => {
  it('按规则流转，重复动作幂等', () => {
    const created = upsertMuckOrder([], input({}), dispatcherA)
    const id = Number(created.id)

    const shipped = transitionMuckRow(created.rows, id, '安排装车', dispatcherA)
    expect(shipped.rows[0].status).toBe('运输中')

    const again = transitionMuckRow(shipped.rows, id, '安排装车', dispatcherA)
    expect(again.ok).toBe(true) // 已是运输中：重复动作幂等空操作
    expect(again.rows[0].status).toBe('运输中')

    const done = transitionMuckRow(shipped.rows, id, '确认消纳', dispatcherA)
    expect(done.rows[0].status).toBe('已消纳')
    expect(done.rows[0].pending).toBe(false)

    const repeated = transitionMuckRow(done.rows, id, '确认消纳', dispatcherA)
    expect(repeated.ok).toBe(true) // 重复确认是幂等空操作
    expect(repeated.rows).toHaveLength(1)
  })

  it('待装车可以直接登记滞留', () => {
    const created = upsertMuckOrder([], input({}), dispatcherA)
    const retained = transitionMuckRow(created.rows, Number(created.id), '登记滞留', dispatcherA)
    expect(retained.rows[0].status).toBe('已滞留')
    expect(countRetained(retained.rows)).toBe(1)
  })
})

describe('环次同步：外运结论同步到出土方量清单', () => {
  const ringRows: EntryRow[] = [
    { id: 1, status: '掘进中', pending: true, abnormal: false, 环号: 'R-108', 出土方量: '152' },
    { id: 2, status: '掘进中', pending: true, abnormal: false, 环号: 'R-109', 出土方量: '149' },
  ]

  it('已消纳车次的方量合计写入对应环号，滞留车次一并同步', () => {
    const muck = [
      legacyRow({ id: 1, 对应环号: 'R-108', 渣土方量: '42.5', status: '已消纳' }),
      legacyRow({ id: 2, 对应环号: 'R-108', 渣土方量: '41.0', status: '已消纳' }),
      legacyRow({ id: 3, 对应环号: 'R-108', 渣土方量: '39.8', status: '已滞留' }),
    ]
    const synced = syncRingRows(muck, ringRows)
    expect(synced[0]['出土方量']).toBe('83.5')
    expect(synced[0]['滞留车次']).toBe(1)
    // 没有外运结论的环号保留台账原值（兼容存量读取）
    expect(synced[1]['出土方量']).toBe('149')
  })

  it('清单与统计同源：两处读到的滞留车次一致', () => {
    const muck = [
      legacyRow({ id: 1, 对应环号: 'R-108', status: '已滞留' }),
      legacyRow({ id: 2, 对应环号: 'R-109', status: '已滞留' }),
      legacyRow({ id: 3, 对应环号: 'R-109', status: '运输中' }),
    ]
    const manifest = deriveRingSoil(muck, ringRows)
    const retainedInManifest = manifest.reduce((sum, entry) => sum + entry.滞留车次, 0)
    expect(retainedInManifest).toBe(countRetained(muck))
    expect(selectMuckStats(muck, '2026-10-06').滞留车次).toBe(countRetained(muck))
  })
})

describe('基础解析', () => {
  it('parseShipDate 兼容多种写法', () => {
    expect(parseShipDate('2026-09-28 08:00-10:00')).toBe('2026-09-28')
    expect(parseShipDate('2026-9-8 早班')).toBe('2026-09-08')
    expect(parseShipDate('没有日期')).toBe('')
  })

  it('车队按车牌尾号稳定划分', () => {
    expect(fleetForVehicle('沪A10231')).toBe('渣土一队')
    expect(fleetForVehicle('沪A10232')).toBe('渣土二队')
    expect(fleetForVehicle('沪A10231')).toBe(fleetForVehicle('沪A10231'))
  })
})

// ---------------------------------------------------------------------------
// 服务层：迁移、事务撤回、列表读取
// ---------------------------------------------------------------------------

describe('服务层（localStorage 落库）', () => {
  let store: Map<string, string>

  beforeEach(async () => {
    store = new Map()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => void store.set(key, String(value)),
        removeItem: (key: string) => void store.delete(key),
      },
    })
    const { reloadFromStorage } = await import('@/data/local-store')
    reloadFromStorage()
  })

  it('首次读取自动迁移存量运输单：重复单合并、残留标记清理', async () => {
    const { listMuck } = await import('@/api/muck-service')
    const result = listMuck({}, 1, 50)
    const 单号 = result.items.map((row) => row['运输单号'])
    expect(new Set(单号).size).toBe(单号.length) // 没有重复运输单
    expect(result.items.every((row) => row.abnormal === false)).toBe(true)
    expect(result.items.every((row) => row['版本'] === MUCK_SCHEMA_VERSION)).toBe(true)
    // 滞留车次优先排在最前
    expect(result.items[0].status).toBe('已滞留')
  })

  it('提交后列表与详情读到的滞留车次一致', async () => {
    const { getMuckOrder, listMuck, submitMuck, transitionMuck } = await import('@/api/muck-service')
    const created = submitMuck(input({ 运输单号: 'MUCK-2001' }), dispatcherA)
    expect(created.ok).toBe(true)
    const retained = transitionMuck(Number(created.id), '登记滞留', dispatcherA)
    expect(retained.ok).toBe(true)

    const list = listMuck({}, 1, 50)
    const detail = getMuckOrder(Number(created.id))
    expect(list.stats.滞留车次).toBe(detail.stats.滞留车次)
  })

  it('外运结论同步到掘进环次的出土方量清单', async () => {
    const { listRingOptions, ringSoilManifest, submitMuck, transitionMuck } = await import(
      '@/api/muck-service'
    )
    const ring = listRingOptions()[0]
    const created = submitMuck(
      input({ 运输单号: 'MUCK-3001', 对应环号: ring, 渣土方量: 40 }),
      dispatcherA,
    )
    transitionMuck(Number(created.id), '安排装车', dispatcherA)
    transitionMuck(Number(created.id), '确认消纳', dispatcherA)

    const manifest = ringSoilManifest()
    const entry = manifest.find((item) => item.环号 === ring)
    expect(entry).toBeDefined()
    expect(entry!.出土方量).toBeGreaterThanOrEqual(40)
    expect(entry!.已消纳车次).toBeGreaterThanOrEqual(1)
  })

  it('落库不成就整套撤回：运输单与环次都不留半截改动', async () => {
    const service = await import('@/api/muck-service')
    const { listRows } = await import('@/data/local-store')
    const before = listRows('muck').length

    const original = window.localStorage.setItem
    window.localStorage.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    const result = service.submitMuck(input({ 运输单号: 'MUCK-4001' }), dispatcherA)
    window.localStorage.setItem = original

    expect(result.ok).toBe(false)
    expect(result.message).toContain('撤回')
    expect(listRows('muck')).toHaveLength(before) // 缓存也没有残留
  })

  it('取数失败抛出可重试的错误，不顶用上一轮结果', async () => {
    const service = await import('@/api/muck-service')
    const { storageKey } = await import('@/data/local-store')
    store.set(storageKey(), '{broken json')
    // 坏数据会被读档逻辑回退到种子数据，读取本身可恢复
    const recovered = service.listMuck({}, 1, 5)
    expect(recovered.items.length).toBeGreaterThan(0)
  })
})
