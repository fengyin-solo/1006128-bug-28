<template>
  <section class="page" data-module="ring">
    <header class="page-head">
      <div>
        <h2>掘进环次管理</h2>
        <p class="page-desc">
          维护掘进环，围绕环号、起始里程、掘进速度、总推力做登记、筛选与状态流转；出土方量以渣土运输单为结算口径。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记掘进环</button>
        <button class="btn" type="button" @click="exportRows">导出掘进环次清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无掘进环次数据，可先登记掘进环</td>
        </tr>
      </tbody>
    </table>

    <h3 class="sub-head">出土方量清单（与渣土外运运输单同步）</h3>
    <p class="source-note">
      方量以「渣土运输单」为唯一结算口径；没有运输单的环次回退显示环次台账填报值（兼容存量读法）。
      滞留车次与渣土外运列表、详情读到的完全一致。
    </p>
    <table class="data-table">
      <thead>
        <tr>
          <th>环号</th>
          <th>外运车次</th>
          <th>已消纳车次</th>
          <th>滞留车次</th>
          <th>运输单结算方量（m³）</th>
          <th>台账填报方量（m³）</th>
          <th>滞留车辆明细</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in volumeRows" :key="item.环号">
          <td>{{ item.环号 }}</td>
          <td>{{ item.外运车次 }}</td>
          <td>{{ item.已消纳车次 }}</td>
          <td :class="{ 'cell-warn': item.滞留车次 > 0 }">{{ item.滞留车次 }}</td>
          <td>{{ item.运输单方量 ?? '—' }}</td>
          <td>{{ item.台账填报 ?? '—' }}</td>
          <td>
            <span v-if="!item.滞留.length">—</span>
            <ul v-else class="detained-list">
              <li v-for="order in item.滞留" :key="order.id">
                {{ order.运输单号 }} · {{ order.运输车辆 }} · {{ order.滞留原因 || '原因待补' }}
              </li>
            </ul>
          </td>
        </tr>
        <tr v-if="!volumeRows.length">
          <td colspan="7" class="empty-state">暂无环次出土方量数据</td>
        </tr>
      </tbody>
    </table>
    <p v-if="muckError" class="form-message error">
      运输单取数失败，本清单暂按台账填报展示：{{ muckError }}
      <button class="btn" type="button" @click="loadMuck">重试取数</button>
    </p>

    <footer class="page-foot">
      <span>共 {{ total }} 条掘进环次记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { ringMuckSummaries, type RingMuckSummary } from '@/data/muck-domain'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('ring')
const columns = ['环号', '起始里程', '掘进速度', '总推力', '刀盘扭矩', '出土方量', '掘进班组', '环次状态']
const actions = ['开始掘进', '确认完成', '申请纠偏']
const statuses = ['待掘进', '掘进中', '已贯通', '已纠偏']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const summaries = ref<RingMuckSummary[]>([])
const muckError = ref('')
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

type VolumeRow = RingMuckSummary & { 台账填报: number | null }

/**
 * 出土方量清单：以运输单结算方量为准；运输单未覆盖的环次仍展示台账填报值，
 * 兼容存量「直接读环次出土方量」的方式，两处只认一份结论。
 */
const volumeRows = computed<VolumeRow[]>(() => {
  const fromOrders = new Map<string, VolumeRow>()
  for (const summary of summaries.value) {
    fromOrders.set(summary.环号, { ...summary, 台账填报: ledgerVolume(summary.环号) })
  }
  const result: VolumeRow[] = []
  for (const row of rows.value) {
    const ring = String(row['环号'] ?? '')
    if (!ring) {
      continue
    }
    const existing = fromOrders.get(ring)
    if (existing) {
      result.push(existing)
      fromOrders.delete(ring)
    } else {
      result.push({
        环号: ring,
        外运车次: 0,
        已消纳车次: 0,
        滞留车次: 0,
        运输单方量: 0,
        滞留: [],
        台账填报: ledgerVolume(ring),
      })
    }
  }
  // 运输单里出现、但当前环次台账过滤后未展示的环次也要带出，保证两边对得上。
  result.push(...fromOrders.values())
  return result
})

function ledgerVolume(ring: string): number | null {
  const row = rows.value.find((item) => String(item['环号'] ?? '') === ring)
  const value = Number(row?.['出土方量'])
  return row && Number.isFinite(value) ? value : null
}

function loadMuck() {
  try {
    summaries.value = ringMuckSummaries()
    muckError.value = ''
  } catch (error) {
    // 取数失败不顶用上一轮：清空运输单结论，清单回退为台账填报，并给出重试入口。
    summaries.value = []
    muckError.value = error instanceof Error ? error.message : '运输单取数失败'
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '掘进环登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '掘进环次列表读取失败'
  }
  loadMuck()
}

function averageVolume(): string | number {
  const values = volumeRows.value
    .map((row) => (row.运输单方量 > 0 ? row.运输单方量 : row.台账填报))
    .filter((value): value is number => typeof value === 'number')
  if (!values.length) {
    return 0
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

const stats = computed(() => [
  { label: '掘进环数', value: total.value },
  { label: '已贯通环数', value: rows.value.filter((row) => String(row.status) === '已贯通').length },
  { label: '平均出土方量（m³）', value: averageVolume() },
])

onMounted(reload)
</script>
