import { ApiError } from './apiClient.js'

// The operator key is a SEPARATE credential from the tenant auth token — stored under its own key
// so signing into the console never touches (or is touched by) tenant auth.
const ADMIN_KEY_STORAGE = 'keren.admin_key'

export const getAdminKey = (): string => localStorage.getItem(ADMIN_KEY_STORAGE) || ''
export const setAdminKey = (key: string): void => localStorage.setItem(ADMIN_KEY_STORAGE, key)
export const clearAdminKey = (): void => localStorage.removeItem(ADMIN_KEY_STORAGE)

async function adminFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1/admin${path}`, {
    ...options,
    headers: {
      // Only when there IS a body. Fastify rejects an empty body that announces itself as JSON
      // (FST_ERR_CTP_EMPTY_JSON_BODY) before routing, which is what made every body-less mutation
      // in the tenant dashboard fail silently. `rotateKey` carried a `body: '{}'` workaround for
      // exactly this; the workaround is gone now that the cause is.
      ...(options?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${getAdminKey()}`,
      ...options?.headers,
    },
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = await res.json()
      message = body.message || body.error || message
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message)
  }
  return res.json() as Promise<T>
}

// --- Types (mirror src/modules/admin/admin.service.ts) ---

export interface AdminOverview {
  tenants: { total: number; active: number; suspended: number }
  totals: { leads: number; conversations: number; messages: number; calls: number; meetings: number; voiceMinutes: number }
  last24h: { leads: number; messages: number; calls: number }
}

export interface TenantRollup {
  id: string
  name: string
  slug: string
  isActive: boolean
  hasApiKey: boolean
  planCode: string | null
  billingStatus: string
  createdAt: string
  leads: number
  conversations: number
  messages: number
  calls: number
  voiceMinutes: number
  meetings: number
  lastActivityAt: string | null
}

export interface TenantDetail {
  tenant: { id: string; name: string; slug: string; isActive: boolean; hasApiKey: boolean; settings: unknown; createdAt: string; updatedAt: string; planCode: string | null; billingStatus: string; quotaEnforcement: string }
  stats: {
    leads: { total: number; byStatus: Record<string, number> }
    conversations: number
    messages: { total: number; inbound: number; outbound: number }
    calls: { total: number; voiceMinutes: number; byOutcome: Record<string, number> }
    meetings: { total: number; upcoming: number }
  }
  /** Open billing period. `measuredCostMilliAgorot` is OPERATOR-ONLY — never render it tenant-side. */
  openPeriod: {
    periodStart: string
    periodEnd: string
    includedMinutes: number | null
    overagePerMinuteAgorot: number
    secondsUsed: number
    measuredCostMilliAgorot: number
    /** Cost split by provider, in milli-agorot. A line at exactly 0 means "not measured". */
    costByComponent: { llm: number; stt: number; tts: number; platform: number }
  } | null
}

export interface CreatedTenant {
  id: string
  name: string
  slug: string
  planCode: string
  billingStatus: string
  isActive: boolean
  apiKey: string // shown once
}

/**
 * A plan an operator can put a customer on.
 *
 * `isActive` false means "we use this, we do not sell it" — the internal tier our own workspaces
 * belong on. Listed rather than hidden, because those workspaces have to be creatable too.
 */
export interface Plan {
  code: string
  name: string
  nameHe: string | null
  monthlyPriceAgorot: number
  /** Superseded by `includedMinutes` as the billable unit; still served for historical periods. */
  includedLeads: number | null
  overagePerLeadAgorot: number
  /** The bundle the customer buys. Null = unmetered. */
  includedMinutes: number | null
  overagePerMinuteAgorot: number
  isActive: boolean
}

export interface RotatedKey {
  id: string
  name: string
  apiKey: string // shown once
}

// --- Endpoints ---

export const fetchAdminOverview = () => adminFetch<AdminOverview>('/overview')
export const fetchAdminTenants = () => adminFetch<{ data: TenantRollup[] }>('/tenants')
export const fetchAdminTenant = (id: string) => adminFetch<TenantDetail>(`/tenants/${id}`)

export const fetchAdminPlans = () => adminFetch<{ data: Plan[] }>('/plans')

export const createTenant = (input: { name: string; slug: string; planCode: string }) =>
  adminFetch<CreatedTenant>('/tenants', { method: 'POST', body: JSON.stringify(input) })

/**
 * `planCode`, `billingStatus` and `quotaEnforcement` are operator-only — deliberately absent from
 * the tenant's own PATCH, so nobody can move themselves onto a cheaper plan or switch off their
 * own quota.
 *
 * A plan change does NOT reprice the billing period it lands in: `usage_periods` snapshots the
 * plan at period open so a change on the 20th cannot rewrite the 19 days already billed. When the
 * plan changes, the response carries `openPeriodStillPricedAs` so the caller can show what the
 * current invoice still reflects.
 */
export const updateTenant = (
  id: string,
  patch: {
    name?: string
    slug?: string
    isActive?: boolean
    planCode?: string
    billingStatus?: string
    quotaEnforcement?: string
  },
) =>
  adminFetch<{
    id: string
    name: string
    slug: string
    isActive: boolean
    planCode: string | null
    billingStatus: string
    quotaEnforcement: string
    openPeriodStillPricedAs?: { planCode: string; periodEnd: string; monthlyPriceAgorot: number }
    note?: string
  }>(`/tenants/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

export const rotateTenantKey = (id: string) =>
  adminFetch<RotatedKey>(`/tenants/${id}/rotate-key`, { method: 'POST' })

/** Verify a candidate key by hitting a cheap admin route. Returns true if accepted. */
export async function verifyAdminKey(key: string): Promise<boolean> {
  const prev = getAdminKey()
  setAdminKey(key)
  try {
    await fetchAdminOverview()
    return true
  } catch {
    if (prev) setAdminKey(prev)
    else clearAdminKey()
    return false
  }
}

// --- Per-call voice report (mirrors src/modules/metrics/call-report{-view,.service}.ts) ---

/**
 * What the badge on one of her turns may say. THE UNION IS THE POINT: "not measured" is a
 * different fact from "measured as zero", and the server takes care never to collapse them, so
 * nothing on the page may either.
 */
export type FirstAudio =
  /** `source` names which instrument produced the number — they are not interchangeable evidence. */
  | { state: 'measured'; ms: number; source: 'first_audio_frame' | 'dead_air' }
  | { state: 'caller_not_waiting' }
  | { state: 'not_recorded' }

export interface ReportTranscriptLine {
  atMs: number
  role: string
  text: string
  spokeAtMs: number | null
  spokeUntilMs: number | null
  turnIndex: number | null
  /** Non-null on exactly one line per turn. Null means render NO badge — not a dash. */
  firstAudio: FirstAudio | null
}

export interface ReportToolCall {
  atMs: number | null
  name: string
  durationMs: number | null
  ok: boolean | null
  error: string | null
}

export interface Verdict {
  id: string
  status: 'pass' | 'warn' | 'fail'
  value: number | null
  unit: 'count' | 'ms' | 'none'
  detail?: Record<string, string | number | boolean>
}

export interface TurnAnatomy {
  index: number
  atMs: number
  eouMs: number | null
  deadAirMs: number | null
  firstAudioMs: number | null
  modelTtftMs: number | null
  ttsTtfbMs: number | null
  inferenceSteps: number
  draftsDiscarded: number
  toolNames: string[]
  audioBeforeFirstToken: boolean | null
  klass: 'receipt_early' | 'no_receipt' | 'tool_step' | 'unknown'
}

export interface ClassStats {
  n: number
  deadAirP50: number | null
  deadAirP90: number | null
  modelTtftP50: number | null
  ttsTtfbP50: number | null
  firstAudioP50: number | null
}

export interface LatencySummary {
  turns: number
  audioBeforeFirstTokenPct: number | null
  audioBeforeFirstTokenSamples: number
  byClass: Record<string, ClassStats>
  all: ClassStats
}

export interface CallReportView {
  raw: {
    room: string | null
    callerPhone: string | null
    startedAt: string | null
    durationSec: number | null
    config: Record<string, unknown> | null
    pipeline: unknown
    /** Verbatim from the agent, ~35 keys and growing. Typed loosely on purpose. */
    summary: Record<string, unknown>
    compliance: Record<string, unknown> | null
    usage: unknown
  }
  turns: TurnAnatomy[]
  turnsSource: 'derived' | 'report' | 'none'
  turnsDetected: boolean
  latency: LatencySummary | null
  latencyFromReport: LatencySummary | null
  transcript: ReportTranscriptLine[]
  toolCalls: ReportToolCall[] | null
  verdicts: Verdict[]
}

export interface CallReportEnvelope {
  learningId: string
  tenantId: string
  tenantName: string | null
  room: string | null
  createdAt: string | null
  durationSecs: number | null
  status: string
  outcome: string | null
  endReason: string | null
  /** The audio is with the provider and nothing serves it. Never render a player. */
  recordingStored: boolean
  report: CallReportView | null
  absence: 'no_learnings_row' | 'no_report' | null
}

export interface AdminCallListItem {
  learningId: string
  tenantId: string
  tenantName: string | null
  room: string | null
  createdAt: string | null
  durationSecs: number | null
  status: string
  outcome: string | null
  hasReport: boolean
}

export const fetchAdminCalls = (params?: { tenantId?: string; withReport?: boolean; limit?: number }) => {
  const q = new URLSearchParams()
  if (params?.tenantId) q.set('tenantId', params.tenantId)
  if (params?.withReport) q.set('withReport', 'true')
  if (params?.limit) q.set('limit', String(params.limit))
  const qs = q.toString()
  return adminFetch<{ data: AdminCallListItem[] }>(`/calls${qs ? `?${qs}` : ''}`)
}

export const fetchAdminCallReport = (id: string) =>
  adminFetch<CallReportEnvelope>(`/calls/${id}/report`)
