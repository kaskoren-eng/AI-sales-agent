import { and, eq } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import { conversations, leads } from '../../../db/schema/index.js';

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
 * room name — the call's id everywhere (the same role Retell's call_id plays). Returns the new
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
