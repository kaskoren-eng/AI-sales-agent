import { and, eq } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import { conversations, leads } from '../../../db/schema/index.js';
import { upsertLead } from './tools/lead-store.js';

/**
 * Task 0 — make LiveKit calls VISIBLE in the dashboard.
 *
 * The calls list (`CallsService.listCalls`) inner-joins `conversations` (channel='voice') to
 * `leads`. Until this file, nothing created that row for a LiveKit call, so every self-built call
 * was invisible in the dashboard and its `call_learnings` join returned null. These helpers create
 * the row at call INITIATION (dispatcher side — outbound dialer + web-call route, both of which have
 * a fast local DB), so the call shows up the moment it starts, not only if it happens to end well.
 *
 * The conversationId is threaded back to the agent in call metadata so the end-of-call finalization
 * can update THIS row (status='ended', summary) instead of orphaning it. See tool-context.ts.
 */

/** Sentinel source for the single reusable browser-simulator lead. Real leads never use it. */
export const WEB_CALL_PLACEHOLDER_SOURCE = 'web-call';

/**
 * A web (browser simulator) call has no real lead, but the calls list inner-joins one. Rather than
 * litter the leads table with a row per simulator session, we reuse ONE placeholder lead per tenant
 * ("Web simulator"). Find-or-create, tenant-scoped. A rare duplicate under a race is cosmetic.
 */
export async function ensureWebCallPlaceholderLead(db: Database, tenantId: string): Promise<string> {
  const [existing] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.tenantId, tenantId), eq(leads.source, WEB_CALL_PLACEHOLDER_SOURCE)))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(leads)
    .values({
      tenantId,
      name: 'Web simulator',
      source: WEB_CALL_PLACEHOLDER_SOURCE,
      status: 'new',
      metadata: { placeholder: true },
    })
    .returning({ id: leads.id });
  return created!.id;
}

/**
 * Creates the `conversations` row that surfaces a LiveKit call in the dashboard. `channelRef` is the
 * room name — the call's id everywhere. Returns the new
 * conversationId so the caller can ship it to the agent for end-of-call finalization.
 */
export async function createVoiceConversation(
  db: Database,
  params: { tenantId: string; leadId: string; roomName: string },
): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({
      tenantId: params.tenantId,
      leadId: params.leadId,
      channel: 'voice',
      channelRef: params.roomName,
      status: 'active',
    })
    .returning({ id: conversations.id });
  return row!.id;
}

/**
 * Agent-side Task 0, for calls with NO dispatcher-created conversation row: inbound SIP phone calls
 * (which have no dialer/web-call route to make the row), and — as a fallback — any outbound/web-call
 * where the dispatcher insert failed. Resolves the caller's lead (given id → phone match → fresh
 * insert, via upsertLead) and opens the voice conversation so the call shows up in the dashboard
 * list exactly like a simulator or outbound call.
 *
 * Returns the resolved ids, or null when no lead could be resolved (then no row is made and the call
 * simply isn't listed — never a broken call). The phone-based upsert means this and a later
 * book_meeting/capture converge on the SAME lead even if they race.
 */
export async function ensureAgentSideConversation(
  db: Database,
  params: { tenantId: string; leadId: string | null; callerPhone: string | null; roomName: string },
): Promise<{ leadId: string; conversationId: string } | null> {
  const leadId =
    params.leadId ??
    (await upsertLead(db, params.tenantId, { leadId: null, callerPhone: params.callerPhone }, {}));
  if (!leadId) return null;
  const conversationId = await createVoiceConversation(db, {
    tenantId: params.tenantId,
    leadId,
    roomName: params.roomName,
  });
  return { leadId, conversationId };
}
