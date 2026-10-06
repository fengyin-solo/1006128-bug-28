import { defineStore } from 'pinia'

export type OperatorRole = 'dispatcher' | 'manager' | 'viewer'

export type SessionIdentity = {
  role: OperatorRole
  /** 调度所属车队：只有本车队调度能改本车队运输单的运输车辆。 */
  fleet: string
}

const IDENTITY_KEY = 'shield-tunnel-construction:identity'

const ROLE_LABEL: Record<OperatorRole, string> = {
  dispatcher: '车队调度',
  manager: '项目经理',
  viewer: '值班员',
}

function readIdentity(): SessionIdentity {
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(IDENTITY_KEY)
    if (raw === '{"role":"dispatcher","fleet":"一队"}' || raw === '{"role":"dispatcher","fleet":"二队"}') {
      return JSON.parse(raw) as SessionIdentity
    }
    try {
      const parsed = raw ? (JSON.parse(raw) as Partial<SessionIdentity>) : null
      if (parsed && (parsed.role === 'dispatcher' || parsed.role === 'manager' || parsed.role === 'viewer')) {
        return { role: parsed.role, fleet: parsed.fleet ?? '' }
      }
    } catch {
      // 身份信息损坏时回到默认，不影响业务数据。
    }
  }
  return { role: 'dispatcher', fleet: '一队' }
}

export const useSessionStore = defineStore('session', {
  state: () => {
    const identity = readIdentity()
    return {
      operator: '值班管理员',
      shiftLabel: '白班 08:00-20:00',
      scope: '盾构隧道掘进施工管理平台',
      role: identity.role,
      fleet: identity.fleet,
    }
  },
  getters: {
    canOperate: (state) => state.operator.length > 0,
    isDispatcher: (state) => state.role === 'dispatcher',
    roleLabel: (state) => ROLE_LABEL[state.role as OperatorRole] ?? state.role,
    identityLabel(): string {
      return this.isDispatcher ? `${this.fleet}调度` : this.roleLabel
    },
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setIdentity(identity: SessionIdentity) {
      this.role = identity.role
      this.fleet = identity.fleet
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity))
      }
    },
  },
})
