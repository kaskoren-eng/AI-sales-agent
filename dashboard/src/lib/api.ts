import { apiFetch } from './apiClient.js'
import type {
  CallsFilters,
  CallsListResponse,
  CallDetail,
  LeadsFilters,
  LeadsListResponse,
  LeadTimelineResponse,
  BookingsListResponse,
  TenantMe,
} from './types.js'

export function fetchCalls(filters: CallsFilters = {}): Promise<CallsListResponse> {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.qualification) params.set('qualification', filters.qualification)
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  if (filters.page != null) params.set('page', String(filters.page))
  if (filters.limit != null) params.set('limit', String(filters.limit))

  const qs = params.toString()
  return apiFetch<CallsListResponse>(`/calls${qs ? `?${qs}` : ''}`)
}

export function fetchCall(id: string): Promise<CallDetail> {
  return apiFetch<CallDetail>(`/calls/${id}`)
}

export function fetchLeads(filters: LeadsFilters = {}): Promise<LeadsListResponse> {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.search) params.set('search', filters.search)
  if (filters.page != null) params.set('page', String(filters.page))
  if (filters.limit != null) params.set('limit', String(filters.limit))
  const qs = params.toString()
  return apiFetch<LeadsListResponse>(`/leads${qs ? `?${qs}` : ''}`)
}

export function fetchLeadTimeline(id: string): Promise<LeadTimelineResponse> {
  return apiFetch<LeadTimelineResponse>(`/leads/${id}/timeline`)
}

export function updateLead(
  id: string,
  patch: { name?: string | null; email?: string | null; phone?: string | null; status?: string; score?: number | null },
): Promise<LeadTimelineResponse['lead']> {
  return apiFetch(`/leads/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function fetchBookings(): Promise<BookingsListResponse> {
  return apiFetch<BookingsListResponse>('/scheduling/bookings')
}

// --- Dashboard metrics (Overview KPIs, pipeline, quality, trend) ---

export interface MetricsSummary {
  range: 'today' | 'd7' | 'd30'
  from: string
  to: string
  days: number
  kpis: {
    leadsTotal: number
    qualified: number
    booked: number
    callsTotal: number
    callsInRange: number
    qualityScore: number | null
  }
  pipeline: Record<string, number>
  series: Array<{ date: string; leads: number; calls: number }>
}

export function fetchMetricsSummary(range: 'today' | 'd7' | 'd30'): Promise<MetricsSummary> {
  return apiFetch<MetricsSummary>(`/metrics/summary?range=${range}`)
}

// --- Voice-agent supervision metrics (Voice Ops page) ---

export interface VoiceMetrics {
  range: 'today' | 'd7' | 'd30'
  from: string
  to: string
  days: number
  calls: { total: number; failed: number; totalDurationSecs: number; avgDurationSecs: number | null }
  outcomes: {
    byEndReason: Record<string, number>
    withEndReason: number
    booked: number
    /** null (not 0) when no call recorded an end reason — render as "—". */
    bookingRatePct: number | null
  }
  latency: {
    /** 0 → show the "awaiting data" state; every figure below will be null. */
    callsWithLatency: number
    endOfTurnMs: { median: number | null; p95: number | null }
    llmTtftMs: { median: number | null; p95: number | null }
    ttsTtfbMs: { median: number | null; p95: number | null }
    worstCaseMs: { median: number | null; p95: number | null; max: number | null }
  }
  attention: {
    failedCalls: number
    disclosureMissed: number
    fragmentedTurnCalls: number
    fragmentedTurnsTotal: number
    cutOffsTotal: number
    overBudgetToolCalls: number
  }
  cost: { minutes: number; perMinuteRateUsd: number; estimatedUsd: number; estimated: true }
  series: Array<{ date: string; calls: number; minutes: number; booked: number }>
}

export function fetchVoiceMetrics(range: 'today' | 'd7' | 'd30'): Promise<VoiceMetrics> {
  return apiFetch<VoiceMetrics>(`/metrics/voice?range=${range}`)
}

/**
 * Every workspace this signed-in human belongs to.
 *
 * Lives here rather than in `lib/auth.ts` on purpose: this needs `apiFetch` for the bearer token
 * and the 401-refresh-retry, and `apiClient` already imports from `auth`. Putting it there would
 * close an import cycle for one GET.
 *
 * The server filters out suspended tenants before returning, so a workspace listed here is one
 * the user can actually switch into — picking a dead one and 403-ing on every subsequent request
 * is exactly the confusion this avoids.
 */
export interface Membership {
  tenantId: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
  name: string
  slug: string
}

export async function fetchMemberships(): Promise<Membership[]> {
  const me = await apiFetch<{ tenants?: Membership[] }>('/auth/me')
  return me.tenants ?? []
}

export function fetchTenantMe(): Promise<TenantMe> {
  return apiFetch<TenantMe>('/tenants/me')
}

export function updateTenantMe(data: Partial<Pick<TenantMe, 'name'>>): Promise<TenantMe> {
  return apiFetch<TenantMe>('/tenants/me', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

/**
 * Write ONE section of tenant settings.
 *
 * Settings used to be PATCHed as a single blob through updateTenantMe, which meant the Flows pane
 * loaded every tenant secret into the browser and posted it all back on save. The server now
 * refuses that, and refuses sections it does not consider tenant-owned (spend caps, voice engine,
 * integration credentials) with a 403 explaining where they are managed.
 */
export function updateTenantSettings(
  namespace: 'flows' | 'businessProfile' | 'whatsapp_templates' | 'crm_sync' | 'reminders' | 'operating_hours' | 'ui_locale',
  value: Record<string, unknown>,
): Promise<{ ok: boolean; namespace: string; settings: Record<string, unknown> }> {
  return apiFetch(`/tenants/me/settings/${namespace}`, {
    method: 'PATCH',
    body: JSON.stringify(value),
  })
}

export function fetchTenantFlows(): Promise<Record<string, unknown>> {
  return apiFetch('/tenants/me/flows')
}

export function regenerateApiKey(): Promise<{ apiKey: string }> {
  return apiFetch<{ apiKey: string }>('/tenants/me/api-key', { method: 'POST' })
}

// --- Settings: Business Profile ---

export interface BusinessProfile {
  companyName: string
  description: string
  product: string
  targetAudience: string
  pricing: string
  commonObjections: string
  toneOfVoice: string
  language: 'hebrew' | 'english' | 'both'
}

export function fetchBusinessProfile(): Promise<{ businessProfile: BusinessProfile | null }> {
  return apiFetch('/settings/business-profile')
}

export function saveBusinessProfile(profile: BusinessProfile): Promise<{ ok: boolean; businessProfile: BusinessProfile }> {
  return apiFetch('/settings/business-profile', {
    method: 'PUT',
    body: JSON.stringify(profile),
  })
}

// --- Settings: Voice number ---
//
// This used to be `fetchTwilioSettings` against `/settings/twilio`, a route that does not exist —
// the backend has `/settings/zadarma`. Every load 404'd, so the Settings > Voice pane showed its
// empty "connect your Twilio account" state permanently. Asking the tenant for telephony
// credentials was wrong anyway: ClickScales provisions and assigns the number at onboarding.

export interface VoiceNumberStatus {
  configured: boolean
  phoneNumber: string | null
  configuredAt: string | null
}

export function fetchVoiceNumber(): Promise<VoiceNumberStatus> {
  return apiFetch<VoiceNumberStatus>('/settings/zadarma')
}

// --- Integrations: Airtable ---
//
// The backend has had a complete per-tenant Airtable API for a while — configure (which validates
// the credentials against Airtable BEFORE storing them), status, disconnect, table listing — and
// nothing in the UI called any of it. The Integrations page was a static array of cards, every one
// hardcoded to "Not configured", every button a no-op. So a second tenant had no way to connect
// their own base, which is the whole point of the feature.

export interface AirtableStatus {
  connected: boolean
  baseId?: string
  tableId?: string
  phoneFieldName?: string | null
  emailFieldName?: string | null
}

export function fetchAirtableStatus(): Promise<AirtableStatus> {
  return apiFetch<AirtableStatus>('/integrations/airtable/status')
}

export function configureAirtable(data: {
  apiKey: string
  baseId: string
  tableId: string
  phoneFieldName?: string
  emailFieldName?: string
}): Promise<{ ok: boolean; baseId: string; tableId: string }> {
  return apiFetch('/integrations/airtable/configure', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function disconnectAirtable(): Promise<{ ok: boolean }> {
  return apiFetch('/integrations/airtable/configure', { method: 'DELETE' })
}

// --- Integrations: Monday.com ---

export interface MondayStatus {
  connected: boolean
  boardId?: string
  columnMap?: Record<string, string>
}

export function fetchMondayStatus(): Promise<MondayStatus> {
  return apiFetch<MondayStatus>('/integrations/monday/status')
}

export function disconnectMonday(): Promise<{ ok: boolean }> {
  return apiFetch('/integrations/monday/configure', { method: 'DELETE' })
}

// --- Voice simulator (browser mic session with the LiveKit agent) ---

export interface WebCallSession {
  url: string
  token: string
  roomName: string
}

export function createWebCall(): Promise<WebCallSession> {
  // Explicit empty body: apiFetch always sends Content-Type: application/json, and Fastify
  // rejects a JSON content-type with a zero-length body.
  return apiFetch<WebCallSession>('/voice/web-call', { method: 'POST', body: '{}' })
}

// --- Agent persona (who the agent is on this tenant's calls) ---

export interface PersonaFaqEntry {
  topic: string
  answer: string
}

export interface AgentPersona {
  agentName: string
  agentNameLatin: string
  agentGender: 'female' | 'male'
  companyName: string
  companyDescription: string
  handoffPerson: string
  greeting: string
  faq: PersonaFaqEntry[]
  nameDisambiguation: string
  mindsetRebuttal: string
  tts: { provider?: string; voiceId?: string; speed?: number; volume?: number } | null
}

export interface AgentPersonaResponse {
  persona: AgentPersona
  /**
   * False means this tenant has never set a persona and is inheriting the platform default — i.e.
   * their agent is currently introducing itself to their leads as ClickScales' agent. The page
   * shows that as an unmissable warning rather than as a filled-in form.
   */
  configured: boolean
  /** What a lead actually hears, whether it was written or generated. */
  resolvedGreeting: string
  tts: AgentPersona['tts']
}

/** The fields a tenant may set. Voice is operator-managed and deliberately absent. */
export type AgentPersonaPatch = Pick<
  AgentPersona,
  'agentName' | 'agentGender' | 'companyName' | 'companyDescription' | 'handoffPerson' | 'greeting' | 'faq'
>

export function fetchAgentPersona(): Promise<AgentPersonaResponse> {
  return apiFetch<AgentPersonaResponse>('/settings/agent-persona')
}

export function saveAgentPersona(
  patch: AgentPersonaPatch,
): Promise<{ ok: boolean; persona: AgentPersona; resolvedGreeting: string }> {
  return apiFetch('/settings/agent-persona', { method: 'PUT', body: JSON.stringify(patch) })
}

// --- Team members and invites ---

export type TenantRole = 'owner' | 'admin' | 'member' | 'viewer'

/** Roles an invite may carry. `owner` is absent on purpose: ownership is transferred by an existing
 * owner through a role change, never handed out by emailing a link. Mirrors `inviteSchema`. */
export const INVITABLE_ROLES: TenantRole[] = ['admin', 'member', 'viewer']

export interface Member {
  userId: string
  email: string
  name: string | null
  role: TenantRole
  lastLoginAt: string | null
  joinedAt: string
}

export function fetchMembers(): Promise<{ members: Member[] }> {
  return apiFetch<{ members: Member[] }>('/members')
}

/**
 * `sent: false` comes back with a raw `token` when the server has no `DASHBOARD_BASE_URL` and
 * therefore could not mail the link. That is not an error and must not be swallowed — it is the
 * only way the invite can still be completed, so the UI shows the link instead of claiming success.
 * (This is the same class of failure as the password-reset emails that silently went nowhere.)
 */
export function inviteMember(input: {
  email: string
  role: TenantRole
}): Promise<{ sent: true } | { sent: false; token: string }> {
  return apiFetch('/members/invites', { method: 'POST', body: JSON.stringify(input) })
}

export function updateMemberRole(userId: string, role: TenantRole): Promise<{ ok: boolean }> {
  return apiFetch(`/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) })
}

export function removeMember(userId: string): Promise<void> {
  return apiFetch(`/members/${userId}`, { method: 'DELETE' })
}

// --- Integrations: Google Calendar (per-tenant OAuth) ---

export interface GoogleCalendarStatus {
  connected: boolean
  accountEmail: string | null
  calendarId: string | null
  /** A previous grant was revoked by Google — "reconnect", not "connect". */
  needsReconnect: boolean
  /** False when this deployment has no OAuth app configured; don't offer the button. */
  available: boolean
  /** ClickScales' own tenant, which uses a service account rather than OAuth. */
  usesPlatformCredentials: boolean
}

export function fetchGoogleCalendarStatus(): Promise<GoogleCalendarStatus> {
  return apiFetch<GoogleCalendarStatus>('/integrations/google-calendar/status')
}

/** Returns the Google consent URL to send the customer to. */
export function startGoogleCalendarConnect(): Promise<{ url: string }> {
  return apiFetch('/integrations/google-calendar/connect', { method: 'POST' })
}

export function disconnectGoogleCalendar(): Promise<{ ok: boolean }> {
  return apiFetch('/integrations/google-calendar', { method: 'DELETE' })
}
