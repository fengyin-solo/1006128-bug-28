<template>
  <section class="page" data-module="muck">
    <header class="page-head">
      <div>
        <h2>渣土外运管理</h2>
        <p class="page-desc">
          滞留车次优先列出；消纳场所、运输车辆、外运时段按交集过滤；外运结论同步到掘进环次的出土方量清单。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记渣土运输单</button>
        <button class="btn" type="button" @click="exportRows">导出渣土外运清单</button>
      </div>
    </header>

    <div class="identity-bar">
      <span>当前身份</span>
      <select v-model="session.role" aria-label="角色">
        <option v-for="role in roleOptions" :key="role" :value="role">{{ role }}</option>
      </select>
      <select v-model="session.fleet" aria-label="车队">
        <option v-for="fleet in fleetOptions" :key="fleet" :value="fleet">{{ fleet }}</option>
      </select>
      <span class="hint-text">只有本车队的调度能改运输车辆，越权提交会被拦下</span>
    </div>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">
          {{ item.label }}
          <em v-if="stale" class="stale-tag">已过期</em>
        </span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="status in statuses" :key="status" class="legend-item">
        {{ status }}：{{ statusCounts[status] ?? 0 }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="applyQuery">
      <label class="filter-item">
        <span>消纳场所</span>
        <select v-model="draft.消纳场所">
          <option value="">全部</option>
          <option v-for="site in choices.消纳场所" :key="site" :value="site">{{ site }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>运输车辆</span>
        <select v-model="draft.运输车辆">
          <option value="">全部</option>
          <option v-for="plate in choices.运输车辆" :key="plate" :value="plate">{{ plate }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>外运时段</span>
        <input v-model="draft.外运时段" type="date" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetQuery">重置条件</button>
    </form>

    <p v-if="loadError" class="banner error">
      {{ loadError }}
      <button class="btn" type="button" @click="reload">重试</button>
    </p>
    <p v-else-if="stale" class="banner warn">
      本次取数失败，列表停留在上一轮结果（已过期），请重试。
      <button class="btn" type="button" @click="reload">重试</button>
    </p>
    <p v-if="actionError" class="banner error">{{ actionError }}</p>
    <p v-if="notice" class="banner ok">{{ notice }}</p>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-flash': Number(row.id) === flashId }">
          <td>
            <button class="link" type="button" @click="openDetail(row)">{{ row['运输单号'] }}</button>
          </td>
          <td>{{ row['对应环号'] }}</td>
          <td>{{ row['渣土方量'] }}</td>
          <td>{{ row['运输车辆'] }}</td>
          <td>{{ row['外运时段'] }}</td>
          <td>{{ row['消纳场所'] }}</td>
          <td>{{ row['车队'] }}</td>
          <td>{{ row['押运人员'] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
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
              v-if="String(row.status) !== '已消纳'"
              class="link"
              type="button"
              @click="openEdit(row)"
            >
              改单
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length && !loadError">
          <td :colspan="columns.length + 2" class="empty-state">
            <template v-if="diagnoses.length">没有命中记录。{{ emptyReason }}</template>
            <template v-else>暂无渣土外运数据，可先登记渣土运输单</template>
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条渣土外运记录</span>
      <span class="pagination">
        <button class="btn" type="button" :disabled="muckStore.page <= 1" @click="goPage(-1)">上一页</button>
        <span>第 {{ muckStore.page }} / {{ pageCount }} 页</span>
        <button class="btn" type="button" :disabled="muckStore.page >= pageCount" @click="goPage(1)">下一页</button>
      </span>
    </footer>

    <div v-if="formOpen" class="drawer-mask" @click.self="formOpen = false">
      <aside class="drawer">
        <h3>{{ editingId === null ? '登记渣土运输单' : `修改运输单 ${form.运输单号}` }}</h3>
        <form class="form-grid" @submit.prevent="submitForm">
          <label>
            <span>运输单号</span>
            <input v-model="form.运输单号" :readonly="editingId !== null" placeholder="如 MUCK-0008" required />
          </label>
          <label>
            <span>对应环号</span>
            <select v-model="form.对应环号" required>
              <option value="" disabled>选择环号</option>
              <option v-for="ring in ringOptions" :key="ring" :value="ring">{{ ring }}</option>
            </select>
          </label>
          <label>
            <span>渣土方量（方）</span>
            <input v-model="form.渣土方量" type="number" min="0.1" step="0.1" required />
          </label>
          <label>
            <span>运输车辆</span>
            <input
              v-model="form.运输车辆"
              list="muck-vehicles"
              :disabled="vehicleLocked"
              placeholder="如 沪A10236"
              required
            />
            <datalist id="muck-vehicles">
              <option v-for="plate in choices.运输车辆" :key="plate" :value="plate" />
            </datalist>
            <small v-if="vehicleLocked" class="hint-text">该单属于{{ editingFleet }}，只有本车队调度能改运输车辆</small>
          </label>
          <label>
            <span>外运日期</span>
            <input v-model="form.外运日期" type="date" required />
          </label>
          <label>
            <span>时段</span>
            <select v-model="form.时段">
              <option v-for="slot in slotOptions" :key="slot" :value="slot">{{ slot }}</option>
            </select>
          </label>
          <label>
            <span>消纳场所</span>
            <input v-model="form.消纳场所" list="muck-sites" placeholder="如 东山消纳场" required />
            <datalist id="muck-sites">
              <option v-for="site in choices.消纳场所" :key="site" :value="site" />
            </datalist>
          </label>
          <label>
            <span>押运人员</span>
            <input v-model="form.押运人员" placeholder="选填" />
          </label>
          <p v-if="formError" class="error-text form-error">{{ formError }}</p>
          <div class="drawer-actions">
            <button class="btn primary" type="submit">提交</button>
            <button class="btn ghost" type="button" @click="formOpen = false">取消</button>
          </div>
        </form>
      </aside>
    </div>

    <div v-if="detail" class="drawer-mask" @click.self="detail = null">
      <aside class="drawer">
        <h3>运输单 {{ detail.order['运输单号'] }}</h3>
        <dl class="detail-list">
          <div><dt>对应环号</dt><dd>{{ detail.order['对应环号'] }}</dd></div>
          <div><dt>渣土方量</dt><dd>{{ detail.order['渣土方量'] }} 方</dd></div>
          <div><dt>运输车辆</dt><dd>{{ detail.order['运输车辆'] }}</dd></div>
          <div><dt>所属车队</dt><dd>{{ detail.order['车队'] }}</dd></div>
          <div><dt>外运时段</dt><dd>{{ detail.order['外运时段'] }}</dd></div>
          <div><dt>外运日期</dt><dd>{{ detail.order['外运日期'] }}</dd></div>
          <div><dt>消纳场所</dt><dd>{{ detail.order['消纳场所'] }}</dd></div>
          <div><dt>押运人员</dt><dd>{{ detail.order['押运人员'] || '—' }}</dd></div>
          <div><dt>当前状态</dt><dd>{{ detail.order.status }}</dd></div>
          <div><dt>台账版本</dt><dd>v{{ detail.order['版本'] }}</dd></div>
        </dl>
        <p class="hint-text">
          当前滞留车次 {{ detail.stats.滞留车次 }}（与列表统计同源）；外运结论会同步到环号
          {{ detail.order['对应环号'] }} 的出土方量清单。
        </p>
        <div class="drawer-actions">
          <button
            v-if="String(detail.order.status) !== '已消纳'"
            class="btn"
            type="button"
            @click="openEdit(detail.order)"
          >
            改单
          </button>
          <button class="btn ghost" type="button" @click="detail = null">关闭</button>
        </div>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  getMuckOrder,
  listMuck,
  listRingOptions,
  submitMuck,
  transitionMuck,
} from '@/api/muck-service'
import { FLEETS, MUCK_ACTIONS, MUCK_STATUSES, shipDateOf } from '@/domain/muck'
import type { Actor, FilterDiagnosis, MuckStats } from '@/domain/muck'
import { useMuckStore } from '@/stores/muck'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const session = useSessionStore()
const muckStore = useMuckStore()

const columns = ['运输单号', '对应环号', '渣土方量', '运输车辆', '外运时段', '消纳场所', '车队', '押运人员']
const statuses = MUCK_STATUSES
const roleOptions = ['调度', '值班管理员', '访客']
const fleetOptions = FLEETS
const baseSlots = ['早班 08:00-12:00', '午班 13:00-17:00', '晚班 18:00-22:00']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const pageCount = ref(1)
const stats = ref<MuckStats>({ 今日外运方量: 0, 运输中车辆: 0, 滞留车次: 0 })
const statusCounts = ref<Record<string, number>>({})
const choices = ref<{ 消纳场所: string[]; 运输车辆: string[] }>({ 消纳场所: [], 运输车辆: [] })
const diagnoses = ref<FilterDiagnosis[]>([])
const loadError = ref('')
const actionError = ref('')
const notice = ref('')
const stale = ref(false)
const flashId = ref<number | null>(null)

// 查询草稿：点「查询」才写入共享的筛选状态，翻页只动页码不动条件。
const draft = reactive({ ...muckStore.filters })

const statCards = computed(() => [
  { label: '今日外运方量', value: stats.value.今日外运方量 },
  { label: '运输中车辆', value: stats.value.运输中车辆 },
  { label: '滞留车次', value: stats.value.滞留车次 },
])

const emptyReason = computed(() => {
  const blocked = diagnoses.value.filter((item) => item.survivors === 0)
  if (blocked.length > 0) {
    return `卡住的条件：${blocked
      .map((item) => `「${item.field}=${item.value}」（该条件单独已排除全部记录）`)
      .join('、')}`
  }
  const parts = diagnoses.value.map((item) => `${item.field} ${item.survivors} 条`)
  return `单个条件都有命中（${parts.join('，')}），但没有同时满足全部条件的记录`
})

function actor(): Actor {
  return { name: session.operator, role: session.role, fleet: session.fleet }
}

function reload() {
  notice.value = ''
  try {
    const payload = listMuck(muckStore.filters, muckStore.page, muckStore.pageSize)
    rows.value = payload.items
    total.value = payload.total
    pageCount.value = payload.pageCount
    stats.value = payload.stats
    statusCounts.value = payload.statusCounts
    choices.value = payload.choices
    diagnoses.value = payload.diagnoses
    if (payload.page !== muckStore.page) {
      muckStore.setPage(payload.page)
    }
    loadError.value = ''
    stale.value = false
  } catch (error) {
    // 取数失败：不拿上一轮结果顶数，标成已过期并允许重试
    stale.value = rows.value.length > 0
    loadError.value = error instanceof Error ? error.message : '渣土外运列表读取失败'
  }
}

function applyQuery() {
  muckStore.applyFilters({ ...draft })
  reload()
}

function resetQuery() {
  muckStore.resetFilters()
  Object.assign(draft, muckStore.filters)
  reload()
}

function goPage(delta: number) {
  muckStore.setPage(muckStore.page + delta)
  reload()
}

function exportRows() {
  downloadEntries('muck')
}

function availableActions(row: EntryRow): string[] {
  const status = String(row.status)
  return Object.entries(MUCK_ACTIONS)
    .filter(([, spec]) => spec.from.includes(status))
    .map(([action]) => action)
}

function runAction(action: string, row: EntryRow) {
  actionError.value = ''
  const result = transitionMuck(Number(row.id), action, actor())
  if (!result.ok) {
    actionError.value = result.message
    return
  }
  reload()
  notice.value = result.message
}

// ---------------------------------------------------------------------------
// 登记 / 改单
// ---------------------------------------------------------------------------

const formOpen = ref(false)
const editingId = ref<number | null>(null)
const editingFleet = ref('')
const formError = ref('')
const slotOptions = ref<string[]>([...baseSlots])
const form = reactive({
  运输单号: '',
  对应环号: '',
  渣土方量: 0,
  运输车辆: '',
  外运日期: '',
  时段: baseSlots[0],
  消纳场所: '',
  押运人员: '',
})

const ringOptions = computed(() => listRingOptions())

const vehicleLocked = computed(
  () => editingId.value !== null && editingFleet.value !== '' && editingFleet.value !== session.fleet,
)

function resetForm() {
  form.运输单号 = ''
  form.对应环号 = ringOptions.value[0] ?? ''
  form.渣土方量 = 0
  form.运输车辆 = ''
  form.外运日期 = ''
  form.时段 = baseSlots[0]
  form.消纳场所 = ''
  form.押运人员 = ''
  slotOptions.value = [...baseSlots]
}

function openCreate() {
  if (!session.isDispatcher) {
    actionError.value = '只有调度能提交渣土运输单'
    return
  }
  editingId.value = null
  editingFleet.value = ''
  formError.value = ''
  actionError.value = ''
  resetForm()
  formOpen.value = true
}

function openEdit(row: EntryRow) {
  detail.value = null
  editingId.value = Number(row.id)
  editingFleet.value = String(row['车队'] ?? '')
  formError.value = ''
  form.运输单号 = String(row['运输单号'] ?? '')
  form.对应环号 = String(row['对应环号'] ?? '')
  form.渣土方量 = Number(row['渣土方量']) || 0
  form.运输车辆 = String(row['运输车辆'] ?? '')
  form.外运日期 = shipDateOf(row)
  const datePart = form.外运日期
  const slot = String(row['外运时段'] ?? '').replace(datePart, '').trim()
  slotOptions.value = slot && !baseSlots.includes(slot) ? [slot, ...baseSlots] : [...baseSlots]
  form.时段 = slot || baseSlots[0]
  form.消纳场所 = String(row['消纳场所'] ?? '')
  form.押运人员 = String(row['押运人员'] ?? '')
  formOpen.value = true
}

function submitForm() {
  formError.value = ''
  const result = submitMuck(
    {
      运输单号: form.运输单号,
      对应环号: form.对应环号,
      渣土方量: Number(form.渣土方量),
      运输车辆: form.运输车辆,
      外运时段: `${form.外运日期} ${form.时段}`.trim(),
      消纳场所: form.消纳场所,
      押运人员: form.押运人员,
    },
    actor(),
  )
  if (!result.ok) {
    formError.value = result.message
    return
  }
  // 提交后回到列表确认：关掉表单、刷新列表、高亮刚落库的那一条
  formOpen.value = false
  flashId.value = result.id ?? null
  reload()
  notice.value = `${result.message}，请在列表核对`
}

// ---------------------------------------------------------------------------
// 详情
// ---------------------------------------------------------------------------

const detail = ref<{ order: EntryRow; stats: MuckStats } | null>(null)

function openDetail(row: EntryRow) {
  try {
    detail.value = getMuckOrder(Number(row.id))
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '运输单详情读取失败'
  }
}

onMounted(reload)
</script>
