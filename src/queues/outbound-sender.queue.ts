import type { Queue } from 'bullmq';
import type { Channel } from '../shared/types.js';
import type { WhatsappTemplateKey } from '../modules/channels/whatsapp/whatsapp-window.js';

export interface OutboundSenderJob {
  tenantId: string;
  channel: Channel;
  to: string;
  /** The message text — and, for a WhatsApp template send, the freeform FALLBACK used when the
   * lead's 24h window turns out to be open at send time (freeform is cheaper and more natural). */
  content: string;
  /** Optional since the voice agent produces sends with no conversations row (it passes the call
   * id in metadata instead). Existing producers keep passing it. */
  conversationId?: string;
  /** Email only. Falls back to the legacy 'Follow up' when absent. */
  subject?: string;
  /**
   * WhatsApp only: which template SLOT this send belongs to, with its placeholder variables.
   * The worker decides freeform-vs-template-vs-blocked from the lead's 24h window + consent —
   * the sender never picks the mechanism, only the message.
   */
  template?: { key: WhatsappTemplateKey; variables: Record<string, string> };
  /** Lets the worker resolve the lead (window/consent) without a phone lookup. */
  leadId?: string;
  metadata?: Record<string, unknown>;
}

export function enqueueOutbound(queue: Queue, job: OutboundSenderJob) {
  return queue.add('send-outbound', job, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  });
}
