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

export interface CallLearnings {
  status: 'pending' | 'transcribing' | 'analyzed' | 'failed'
  outcome: 'won' | 'lost' | 'neutral' | null
  end_reason: string | null
  tool_calls: Array<{ atMs: number; name: string; durationMs: number; ok: boolean; error?: string }>
  compliance: {
    recording_notice_played: boolean | null
    recording_notice_at: string | null
    ai_disclosure: 'during_call' | 'at_end' | 'missed' | null
  }
  sales_analysis: {
    overall_effectiveness_score: number | null
    opening_technique: string | null
    closing_technique: string | null
    rapport_building: string | null
    pain_points_uncovered: string[]
    objections: Array<{ objection: string; response: string; handled_well: boolean }>
    key_questions_asked: string[]
    what_worked: string[]
    what_didnt_work: string[]
    recommendations: string[]
  } | null
}

export interface CallDetail extends CallSummary {
  transcript: TranscriptTurn[]
  analysis: Analysis | null
  learnings: CallLearnings | null
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

// ---- Lead Detail: timeline endpoint ----

export interface LeadDetailRow {
  id: string
  tenantId: string
  externalId: string | null
  name: string | null
  email: string | null
  phone: string | null
  source: string | null
  status: string
  score: number | null
  metadata: Record<string, unknown> | null
  lastInboundWhatsappAt: string | null
  createdAt: string
  updatedAt: string
}

export interface LeadConversation {
  id: string
  tenantId: string
  leadId: string
  channel: 'voice' | 'whatsapp' | 'email' | string
  channelRef: string | null
  status: string
  summary: string | null
  createdAt: string
  updatedAt: string
}

export interface LeadMessage {
  id: string
  tenantId: string
  conversationId: string
  direction: 'inbound' | 'outbound'
  role: string
  content: string
  contentType: string | null
  channelMsgId: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

export interface LeadScheduledCall {
  id: string
  tenantId: string
  leadId: string | null
  conversationId: string | null
  provider: string
  providerRef: string | null
  scheduledAt: string
  duration: number | null
  status: string
  attendees: unknown
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface LeadTimelineResponse {
  lead: LeadDetailRow
  conversations: LeadConversation[]
  messages: LeadMessage[]
  scheduledCalls: LeadScheduledCall[]
}

