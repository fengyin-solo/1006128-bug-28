<template>
  <section class="page" data-module="muck">
    <header class="page-head">
      <div>
        <h2>渣土外运管理</h2>
        <p class="page-desc">
          运输单是渣土外运唯一台账：筛选按交集、翻页保留条件；滞留车次在列表、详情与掘进环次清单里只认这一份。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记渣土运输单</button>
        <button class="btn" type="button" @click="exportRows">导出渣土外运清单</button>
      </div>
    </header>

    <div class="identity-bar">
      <label class="identity-item">
        <span>当前身份</span>
        <select :value="identityKey" @change="changeIdentity(($event.target as HTMLSelectElement).value)">
          <option value="dispatcher|一队">一队调度</option>
          <option value="dispatcher|二队">二队调度</option>
          <option value="manager|">项目经理（不可改派车辆）</option>
          <option value="viewer|">值班员（只读）</option>
        </select>
      </label>
      <span class="identity-hint">
        只有本车队调度能登记/改派本车队运输车辆，越权提交一律拦下。
      </span>
    </div>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label" :title="item.title">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span
        v-for="item in statusSummary"
        :key="item.status"
        class="legend-item"
        :class="{ active: item.status === '已滞留' && filters.仅滞留 }"
        role="button"
        tabindex="0"
        @click="toggleDetainedOnly"
        @keydown.enter="toggleDetainedOnly"
      >
        {{ item.status }}：{{ item.count }}<template v-if="item.status === '已滞留'">（点击只看滞留）</template>
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="submitQuery">
      <label class="filter-item">
        <span>消纳场所</span>
        <input v-model="filters.消纳场所" list="muck-site-list" placeholder="按消纳场所筛选" />
      </label>
      <datalist id="muck-site-list">
        <option v-for="site in siteOptions" :key="site" :value="site" />
      </datalist>
      <label class="filter-item">
        <span>运输车辆</span>
        <input v-model="filters.运输车辆" list="muck-vehicle-list" placeholder="按运输车辆筛选" />
      </label>
      <datalist id="muck-vehicle-list">
        <option v-for="vehicle in vehicleOptions" :key="vehicle" :value="vehicle" />
      </datalist>
      <label class="filter-item">
        <span>外运开始</span>
        <input v-model="filters.外运开始" type="date" />
      </label>
      <label class="filter-item">
        <span>外运结束</span>
        <input v-model="filters.外运结束" type="date" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <p v-if="blockedConditions.length" class="filter-diagnostic">
      没有命中任何运输单，卡住在：
      <span v-for="(item, index) in blockedConditions" :key="item.field">
        <strong>{{ item.label }}「{{ item.value }}」</strong><template v-if="index < blockedConditions.length - 1">、</template>
      </span>
      （该条件单独命中 0 条），请放宽后再查。
    </p>
    <p v-else-if="rows.length === 0 && !loadError" class="filter-diagnostic muted">
      没有命中任何运输单：各条件单独都有数据，但组合后交集为空，请逐项放宽。
    </p>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ detained: row.status === '已滞留' }">
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.status === '已滞留'" class="cell-reason">（{{ row.滞留原因 || '原因待补' }}）</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">查看详情</button>
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button
              v-if="canReassign(row)"
              class="link"
              type="button"
              @click="openReassign(row)"
            >
              改派车辆
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">
            {{ loadError ? '列表读取失败，请点击右侧重试' : '当前条件下没有渣土运输单' }}
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条渣土外运记录</span>
      <div class="pager">
        <button class="btn" type="button" :disabled="page <= 1 || loading" @click="goPage(page - 1)">上一页</button>
        <span>第 {{ page }} / {{ totalPages }} 页</span>
        <button
          class="btn"
          type="button"
          :disabled="page >= totalPages || loading"
          @click="goPage(page + 1)"
        >
          下一页
        </button>
      </div>
      <span class="foot-tools">
        <button v-if="loadError" class="btn primary" type="button" @click="reload(true)">重试取数</button>
        <label class="fault-toggle">
          <input type="checkbox" :checked="faults.read" @change="toggleReadFailure(($event.target as HTMLInputElement).checked)" />
          模拟取数失败
        </label>
        <label class="fault-toggle">
          <input type="checkbox" :checked="faults.write" @change="toggleWriteFailure(($event.target as HTMLInputElement).checked)" />
          模拟落库失败
        </label>
      </span>
    </footer>
    <p v-if="message" class="form-message" :class="messageTone">{{ message }}</p>

    <!-- 登记运输单：第一次提交成功后关闭并回到列表确认 -->
    <div v-if="createOpen" class="modal-mask" @click.self="closeCreate">
      <div class="modal">
        <h3>登记渣土运输单</h3>
        <form class="modal-form" @submit.prevent="submitCreate">
          <label>
            <span>运输单号 *</span>
            <input v-model="createForm.运输单号" placeholder="如 YD-20261006-09" />
          </label>
          <label>
            <span>对应环号</span>
            <input v-model="createForm.对应环号" list="muck-ring-list" placeholder="如 R-105" />
          </label>
          <datalist id="muck-ring-list">
            <option v-for="ring in ringOptions" :key="ring" :value="ring" />
          </datalist>
          <label>
            <span>渣土方量（m³）*</span>
            <input v-model.number="createForm.渣土方量" type="number" min="0" step="1" />
          </label>
          <label>
            <span>运输车辆 *</span>
            <select v-model="createForm.运输车辆">
              <option value="" disabled>请选择车辆</option>
              <option v-for="vehicle in assignableVehicles" :key="vehicle" :value="vehicle">
                {{ vehicle }}（{{ fleetOfVehicle(vehicle) }}）
              </option>
            </select>
            <small v-if="identity.role !== 'dispatcher'" class="warn-text">
              当前身份不是车队调度，提交将被拦截。
            </small>
          </label>
          <label>
            <span>外运日期 *</span>
            <input v-model="createForm.外运日期" type="date" />
          </label>
          <label>
            <span>外运时段</span>
            <select v-model="createForm.外运时段">
              <option value="白班 08:00-20:00">白班 08:00-20:00</option>
              <option value="夜班 20:00-08:00">夜班 20:00-08:00</option>
            </select>
          </label>
          <label>
            <span>消纳场所 *</span>
            <select v-model="createForm.消纳场所">
              <option value="" disabled>请选择消纳场所</option>
              <option v-for="site in siteOptions" :key="site" :value="site">{{ site }}</option>
            </select>
          </label>
          <label>
            <span>押运人员</span>
            <input v-model="createForm.押运人员" />
          </label>
          <p v-if="createError" class="form-message error">{{ createError }}</p>
          <div class="modal-actions">
            <button class="btn" type="button" :disabled="submitting" @click="closeCreate">取消</button>
            <button class="btn primary" type="submit" :disabled="submitting">
              {{ submitting ? '提交中…' : '提交登记' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 改派车辆：仅本车队调度可用 -->
    <div v-if="reassignTarget" class="modal-mask" @click.self="reassignTarget = null">
      <div class="modal modal-sm">
        <h3>改派运输车辆</h3>
        <p class="modal-note">
          运输单 {{ reassignTarget.运输单号 }} 当前车辆「{{ reassignTarget.运输车辆 }}」，归属{{ reassignTarget.归属车队 }}。
        </p>
        <form class="modal-form" @submit.prevent="submitReassign">
          <label>
            <span>改派到 *</span>
            <select v-model="reassignVehiclePlate">
              <option value="" disabled>请选择本车队车辆</option>
              <option
                v-for="vehicle in fleetVehicles(reassignTarget.归属车队)"
                :key="vehicle"
                :value="vehicle"
              >
                {{ vehicle }}
              </option>
            </select>
          </label>
          <p v-if="reassignError" class="form-message error">{{ reassignError }}</p>
          <div class="modal-actions">
            <button class="btn" type="button" @click="reassignTarget = null">取消</button>
            <button class="btn primary" type="submit">确认改派</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 详情抽屉：滞留车次与列表同一个选择器（detainedOrders / getOrder） -->
    <div v-if="detailOrder" class="drawer-mask" @click.self="detailOrder = null">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>运输单详情 · {{ detailOrder.运输单号 }}</h3>
          <button class="btn ghost" type="button" @click="detailOrder = null">关闭</button>
        </header>
        <dl class="detail-grid">
          <template v-for="column in detailFields" :key="column">
            <dt>{{ column }}</dt>
            <dd>{{ formatCell(detailOrder, column) }}</dd>
          </template>
          <dt>归属车队</dt>
          <dd>{{ detailOrder.归属车队 }}</dd>
          <dt>当前状态</dt>
          <dd>{{ detailOrder.status }}</dd>
          <dt>滞留原因</dt>
          <dd>{{ detailOrder.滞留原因 || '—' }}</dd>
          <dt>登记时间</dt>
          <dd>{{ detailOrder.登记时间 || '—' }}</dd>
        </dl>
        <section class="detail-detained">
          <h4>本页条件下的滞留车次（{{ detailDetained.length }}）</h4>
          <ul>
            <li v-for="order in detailDetained" :key="order.id">
              {{ order.运输单号 }} · {{ order.运输车辆 }} · {{ order.外运日期 }} · {{ order.消纳场所 }}
            </li>
          </ul>
          <p v-if="!detailDetained.length" class="muted">当前条件下没有滞留车次。</p>
        </section>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { downloadEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import {
  MUCK_STATUSES,
  VEHICLE_FLEET,
  canAssignVehicle,
  createOrder,
  detainedOrders,
  failureState,
  fleetOfVehicle,
  getOrder,
  muckStats,
  queryOrders,
  reassignVehicle as reassignVehicleAction,
  setReadFailure,
  setWriteFailure,
  type Identity,
  type MuckFilter,
  type MuckOrder,
} from '@/data/muck-domain'
import { useSessionStore } from '@/stores/session'
import type { FilterDiagnostic } from '@/data/types'

const meta = moduleMeta('muck')
const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const PAGE_SIZE = 8
const columns = ['运输单号', '对应环号', '渣土方量', '运输车辆', '外运日期', '外运时段', '消纳场所', '押运人员']
const detailFields = columns

const rows = ref<MuckOrder[]>([])
const total = ref(0)
const totalPages = ref(1)
const page = ref(1)
const loading = ref(false)
const loadError = ref('')
const message = ref('')
const messageTone = ref<'ok' | 'error'>('ok')
const diagnostics = ref<FilterDiagnostic[]>([])
const stats = ref(muckStatsSafe())

const filters = reactive<Required<Pick<MuckFilter, '消纳场所' | '运输车辆' | '外运开始' | '外运结束'>> & { 仅滞留: boolean }>({
  消纳场所: '',
  运输车辆: '',
  外运开始: '',
  外运结束: '',
  仅滞留: false,
})

const identity = computed<Identity>(() => ({ role: session.role as Identity['role'], fleet: session.fleet }))
const identityKey = computed(() => `${session.role}|${session.fleet}`)

function changeIdentity(value: string) {
  const [role, fleet] = value.split('|')
  session.setIdentity({ role: role as Identity['role'], fleet })
}

/* ------------------------------ URL 承载条件与页码 ------------------------------ */

function readQuery() {
  filters.消纳场所 = String(route.query.site ?? '')
  filters.运输车辆 = String(route.query.vehicle ?? '')
  filters.外运开始 = String(route.query.from ?? '')
  filters.外运结束 = String(route.query.to ?? '')
  filters.仅滞留 = route.query.detained === '1'
  page.value = Math.max(1, Number(route.query.page ?? 1) || 1)
}

function syncQuery(targetPage = page.value): boolean {
  const query: Record<string, string> = {}
  if (filters.消纳场所) query.site = filters.消纳场所
  if (filters.运输车辆) query.vehicle = filters.运输车辆
  if (filters.外运开始) query.from = filters.外运开始
  if (filters.外运结束) query.to = filters.外运结束
  if (filters.仅滞留) query.detained = '1'
  if (targetPage > 1) query.page = String(targetPage)
  const snapshot = JSON.stringify(query)
  const current = JSON.stringify(
    Object.fromEntries(Object.entries(route.query).map(([k, v]) => [k, String(v)])),
  )
  router.replace({ query })
  return snapshot !== current
}

function currentFilter(): MuckFilter {
  return {
    消纳场所: filters.消纳场所,
    运输车辆: filters.运输车辆,
    外运开始: filters.外运开始,
    外运结束: filters.外运结束,
    仅滞留: filters.仅滞留,
  }
}

/* --------------------------------- 列表读取 --------------------------------- */

function reload(manual = false) {
  loading.value = true
  if (manual) {
    // 手动重试时清掉错误态，重新走一次取数，绝不直接沿用上一轮结果。
    loadError.value = ''
  }
  let result: ReturnType<typeof queryOrders> | null = null
  try {
    result = queryOrders(currentFilter(), page.value, PAGE_SIZE)
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '渣土外运列表读取失败'
    rows.value = []
    total.value = 0
    totalPages.value = 1
    diagnostics.value = []
    loading.value = false
    return
  }
  rows.value = result.items
  total.value = result.total
  page.value = result.page
  totalPages.value = Math.max(1, Math.ceil(result.total / result.size))
  diagnostics.value = result.diagnostics
  loadError.value = ''
  loading.value = false
  refreshStats()
}

function refreshStats() {
  try {
    stats.value = muckStats()
  } catch {
    // 统计失败时保留上一次卡片数据，不影响主列表。
  }
}

function muckStatsSafe() {
  try {
    return muckStats()
  } catch {
    return {
      今日外运方量: 0,
      统计日期: '',
      运输中车辆: 0,
      滞留车次: 0,
      待装车: 0,
      运输中: 0,
      已消纳: 0,
      已滞留: 0,
    }
  }
}

watch(
  () => route.query,
  () => {
    readQuery()
    reload()
  },
)

onMounted(() => {
  readQuery()
  reload()
})

/* --------------------------------- 条件与翻页 --------------------------------- */
// 条件与页码全部写进 URL query，router 的 watcher 是唯一的重新取数触发点；
// 换页、从别处返回、刷新页面，条件都原样保留。

function submitQuery() {
  page.value = 1
  if (!syncQuery(1)) {
    reload()
  }
}

function resetFilters() {
  filters.消纳场所 = ''
  filters.运输车辆 = ''
  filters.外运开始 = ''
  filters.外运结束 = ''
  filters.仅滞留 = false
  page.value = 1
  if (!syncQuery(1)) {
    reload()
  }
}

function toggleDetainedOnly() {
  filters.仅滞留 = !filters.仅滞留
  page.value = 1
  if (!syncQuery(1)) {
    reload()
  }
}

function goPage(target: number) {
  page.value = target
  if (!syncQuery(target)) {
    reload()
  }
}

const blockedConditions = computed(() => diagnostics.value.filter((item) => item.blocked))

/* --------------------------------- 选项与统计 --------------------------------- */

const siteOptions = computed(() => uniqueOptions(rowsAll(), '消纳场所'))
const vehicleOptions = computed(() => uniqueOptions(rowsAll(), '运输车辆'))
const ringOptions = computed(() => uniqueOptions(rowsAll(), '对应环号'))
const assignableVehicles = computed(() => {
  if (identity.value.role !== 'dispatcher') {
    return Object.keys(VEHICLE_FLEET)
  }
  return Object.keys(VEHICLE_FLEET).filter((vehicle) => VEHICLE_FLEET[vehicle] === identity.value.fleet)
})

function rowsAll(): MuckOrder[] {
  try {
    return queryOrders({}, 1, Number.MAX_SAFE_INTEGER).items
  } catch {
    return rows.value
  }
}

function uniqueOptions(source: MuckOrder[], field: keyof MuckOrder): string[] {
  return [...new Set(source.map((order) => String(order[field] ?? '')).filter(Boolean))].sort()
}

function fleetVehicles(fleet: string): string[] {
  return Object.keys(VEHICLE_FLEET).filter((vehicle) => VEHICLE_FLEET[vehicle] === fleet)
}

const statCards = computed(() => [
  {
    label: `今日外运方量（m³）`,
    title: `统计基准日期：${stats.value.统计日期}`,
    value: stats.value.今日外运方量,
  },
  { label: '运输中车辆', title: '运输中状态的去重车辆数', value: stats.value.运输中车辆 },
  { label: '滞留车次', title: '已滞留运输单数（列表/详情/环次清单同一口径）', value: stats.value.滞留车次 },
])

const statusSummary = computed(() =>
  MUCK_STATUSES.map((status) => ({
    status,
    count:
      status === '待装车'
        ? stats.value.待装车
        : status === '运输中'
          ? stats.value.运输中
          : status === '已消纳'
            ? stats.value.已消纳
            : stats.value.已滞留,
  })),
)

function formatCell(row: MuckOrder, column: string): string | number {
  if (column === '渣土方量') {
    return row.渣土方量
  }
  const value = row[column as keyof MuckOrder]
  return value === '' || value === undefined || value === null ? '—' : String(value)
}

/* --------------------------------- 状态动作 --------------------------------- */

function availableActions(row: MuckOrder): string[] {
  if (row.status === '待装车') return ['安排装车', '登记滞留']
  if (row.status === '运输中') return ['确认消纳', '登记滞留']
  if (row.status === '已滞留') return ['安排装车']
  return []
}

function canReassign(row: MuckOrder): boolean {
  return canAssignVehicle(identity.value, row.归属车队)
}

function runAction(action: string, row: MuckOrder) {
  message.value = ''
  const reason = action === '登记滞留' && row.status !== '已滞留'
    ? window.prompt('请填写滞留原因', '消纳场受限或车辆异常，等待处理') ?? ''
    : undefined
  if (action === '登记滞留' && reason !== undefined && reason.trim() === '') {
    flashMessage('登记滞留需要填写原因', 'error')
    return
  }
  const result = transition(action, row.id, reason)
  if (!result.ok) {
    flashMessage(result.message, 'error')
    return
  }
  flashMessage(result.message, 'ok')
  reload()
}

function transition(action: string, id: number, reason?: string) {
  return applyAction(meta.key, id, action, reason)
}

/* --------------------------------- 登记运输单 --------------------------------- */

const createOpen = ref(false)
const submitting = ref(false)
const createError = ref('')
const createForm = reactive({
  运输单号: '',
  对应环号: '',
  渣土方量: 0,
  运输车辆: '',
  外运日期: new Date().toISOString().slice(0, 10),
  外运时段: '白班 08:00-20:00',
  消纳场所: '',
  押运人员: '',
})

function openCreate() {
  createError.value = ''
  Object.assign(createForm, {
    运输单号: '',
    对应环号: '',
    渣土方量: 0,
    运输车辆: '',
    外运日期: new Date().toISOString().slice(0, 10),
    外运时段: '白班 08:00-20:00',
    消纳场所: '',
    押运人员: '',
  })
  createOpen.value = true
}

function closeCreate() {
  createOpen.value = false
}

function submitCreate() {
  createError.value = ''
  // 车辆权限在领域层再校验一遍；这里提前给出身份提示，最终一律以服务端拦截为准。
  const targetFleet = fleetOfVehicle(createForm.运输车辆, '')
  if (createForm.运输车辆 && !canAssignVehicle(identity.value, targetFleet)) {
    createError.value = `越权：该车辆归${targetFleet}，当前身份为「${identity.value.role === 'dispatcher' ? `${identity.value.fleet}调度` : identity.value.role}」，不能登记`
    return
  }
  submitting.value = true
  try {
    const result = createOrder(
      {
        运输单号: createForm.运输单号,
        对应环号: createForm.对应环号,
        渣土方量: Number(createForm.渣土方量),
        运输车辆: createForm.运输车辆,
        外运日期: createForm.外运日期,
        外运时段: createForm.外运时段,
        消纳场所: createForm.消纳场所,
        押运人员: createForm.押运人员,
      },
      identity.value,
    )
    if (!result.ok) {
      createError.value = result.message
      return
    }
    // 第一次提交成功后回到列表确认：关闭弹窗、回到第一页并重新取数。
    createOpen.value = false
    flashMessage(result.duplicated ? result.message : `${result.message}，已回到列表核对`, 'ok')
    page.value = 1
    if (!syncQuery(1)) {
      reload()
    }
  } finally {
    submitting.value = false
  }
}

/* --------------------------------- 改派车辆 --------------------------------- */

const reassignTarget = ref<MuckOrder | null>(null)
const reassignVehiclePlate = ref('')
const reassignError = ref('')

function openReassign(row: MuckOrder) {
  if (!canReassign(row)) {
    flashMessage('越权拦截：只有本车队调度能改派车辆', 'error')
    return
  }
  reassignTarget.value = row
  reassignVehiclePlate.value = ''
  reassignError.value = ''
}

function submitReassign() {
  if (!reassignTarget.value) {
    return
  }
  const result = reassignVehicleAction(reassignTarget.value.id, reassignVehiclePlate.value, identity.value)
  if (!result.ok) {
    reassignError.value = result.message
    return
  }
  reassignTarget.value = null
  flashMessage(result.message, 'ok')
  reload()
}

/* --------------------------------- 详情抽屉 --------------------------------- */

const detailOrder = ref<MuckOrder | null>(null)
const detailDetained = ref<MuckOrder[]>([])

function openDetail(row: MuckOrder) {
  // 详情入口同样回源读这一条，避免与列表出现不一致。
  detailOrder.value = getOrder(row.id) ?? row
  detailDetained.value = detainedOrders(currentFilter())
}

/* --------------------------------- 其它 --------------------------------- */

function exportRows() {
  downloadEntries(meta.key)
}

function flashMessage(text: string, tone: 'ok' | 'error') {
  message.value = text
  messageTone.value = tone
}

const faults = ref(failureState())

function toggleReadFailure(on: boolean) {
  setReadFailure(on)
  faults.value = failureState()
  if (on) {
    reload()
  } else {
    reload(true)
  }
}

function toggleWriteFailure(on: boolean) {
  setWriteFailure(on)
  faults.value = failureState()
}
</script>
