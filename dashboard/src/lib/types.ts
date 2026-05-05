export interface Lead {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  status?: string | null
  score?: number | null
}

export interface Qualification {
  status: string | null
  company_name: string | null
  lead_name: string | null
  lead_email: string | null
  follow_up_scheduled: boolean | null
  lead_primary_challenge: string | null
}

export interface Analysis {
  call_successful: string | null
  transcript_summary: string | null
}

export interface CallSummary {
  id: string
  channel_ref: string | null
  status: string
  created_at: string
  updated_at: string
  duration_secs: number | null
  lead: Lead
  qualification: Qualification
  summary: string | null
}

export interface TranscriptTurn {
  role: 'agent' | 'user'
  message: string
  time_in_call_secs?: number | null
}

export interface CallDetail extends CallSummary {
  transcript: TranscriptTurn[]
  analysis: Analysis | null
  audio_available: boolean
}

export interface CallsMeta {
  page: number
  limit: number
  total: number
  total_pages: number
}

export interface CallsListResponse {
  data: CallSummary[]
  meta: CallsMeta
}

export interface CallsFilters {
  status?: string
  qualification?: string
  from?: string
  to?: string
  page?: number
  limit?: number
}

export interface LeadFull {
  id: string
  tenantId: string
  name: string | null
  email: string | null
  phone: string | null
  channel: string | null
  status: string
  score: number | null
  lastActivityAt: string | null
  createdAt: string
  updatedAt: string
}

export interface LeadsMeta {
  page: number
  limit: number
  total: number
  total_pages: number
}

export interface LeadsListResponse {
  data: LeadFull[]
  meta: LeadsMeta
}

export interface LeadsFilters {
  status?: string
  search?: string
  page?: number
  limit?: number
}

export interface Booking {
  id: string
  leadId: string
  leadName: string | null
  scheduledAt: string
  status: string
  provider: string
  calendarEventId: string | null
  createdAt: string
}

export interface BookingsListResponse {
  data: Booking[]
  meta: {
    page: number
    limit: number
    total: number
    total_pages: number
  }
}

export interface TenantMe {
  id: string
  name: string
  settings: Record<string, unknown> | null
  createdAt: string
}

