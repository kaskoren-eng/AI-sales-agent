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
      'Content-Type': 'application/json',
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
  tenant: { id: string; name: string; slug: string; isActive: boolean; hasApiKey: boolean; settings: unknown; createdAt: string; updatedAt: string }
  stats: {
    leads: { total: number; byStatus: Record<string, number> }
    conversations: number
    messages: { total: number; inbound: number; outbound: number }
    calls: { total: number; voiceMinutes: number; byOutcome: Record<string, number> }
    meetings: { total: number; upcoming: number }
  }
}

export interface CreatedTenant {
  id: string
  name: string
  slug: string
  isActive: boolean
  apiKey: string // shown once
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

export const createTenant = (input: { name: string; slug: string }) =>
  adminFetch<CreatedTenant>('/tenants', { method: 'POST', body: JSON.stringify(input) })

export const updateTenant = (id: string, patch: { name?: string; slug?: string; isActive?: boolean }) =>
  adminFetch<{ id: string; name: string; slug: string; isActive: boolean }>(`/tenants/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

export const rotateTenantKey = (id: string) =>
  adminFetch<RotatedKey>(`/tenants/${id}/rotate-key`, { method: 'POST', body: '{}' })

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
