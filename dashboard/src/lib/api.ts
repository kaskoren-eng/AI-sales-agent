import { apiFetch } from './apiClient.js'
import type {
  CallsFilters,
  CallsListResponse,
  CallDetail,
  LeadsFilters,
  LeadsListResponse,
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

export function fetchBookings(): Promise<BookingsListResponse> {
  return apiFetch<BookingsListResponse>('/scheduling/bookings')
}

export function fetchTenantMe(): Promise<TenantMe> {
  return apiFetch<TenantMe>('/tenants/me')
}

export function updateTenantMe(data: Partial<Pick<TenantMe, 'name' | 'settings'>>): Promise<TenantMe> {
  return apiFetch<TenantMe>('/tenants/me', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
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

// --- Settings: Twilio ---

export interface TwilioStatus {
  configured: boolean
  accountSid: string | null
  phoneNumber: string | null
  authTokenMasked: string | null
  configuredAt: string | null
}

export function fetchTwilioSettings(): Promise<TwilioStatus> {
  return apiFetch('/settings/twilio')
}

export function saveTwilioSettings(data: { accountSid: string; authToken: string; phoneNumber: string }): Promise<{ ok: boolean }> {
  return apiFetch('/settings/twilio', {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export function deleteTwilioSettings(): Promise<{ ok: boolean }> {
  return apiFetch('/settings/twilio', { method: 'DELETE' })
}
