export type Channel = 'whatsapp' | 'email' | 'voice';

export type LeadStatus = 'new' | 'contacted' | 'qualifying' | 'qualified' | 'booked' | 'disqualified';

export type ConversationStatus = 'active' | 'paused' | 'closed';

export type MessageDirection = 'inbound' | 'outbound';

export type MessageRole = 'lead' | 'agent' | 'system';

export type CallStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';

export type ImportJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type ImportSource = 'csv' | 'google_sheets' | 'crm';
