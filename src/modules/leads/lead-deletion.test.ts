import { describe, expect, it, vi } from 'vitest';
import { LeadService } from './lead.service.js';
import { leads, conversations, messages, scheduledCalls } from '../../db/schema/index.js';
import type { Database } from '../../db/client.js';

/**
 * ERASING A LEAD.
 *
 * `docs/legal-drafts/` promises deletion on request and nothing implemented it, so the only honest
 * answer to "please delete my data" was a hand-written SQL statement — and the only record that it
 * happened was somebody remembering.
 *
 * The things worth pinning here are the ones that are easy to get wrong and hard to notice:
 *
 *   • ORDER. No child FK cascades, so deleting the lead first fails on a foreign key and nothing is
 *     erased. Deleting SOME children and then failing is worse: orphans pointing at a lead that no
 *     longer exists, still holding the data, with nothing able to find them to try again.
 *   • TENANT SCOPE on every statement, not just the ownership check — so a bug in the check cannot
 *     become a cross-tenant delete.
 *   • WHAT SURVIVES. The usage ledger stays (a count, not a person; and deletion must not be a way
 *     out of an invoice). Calendar events stay (cancelling a real meeting is not what "delete this
 *     lead" asks for).
 */

const TENANT = 'tenant-1';
const LEAD = 'lead-1';

/**
 * Every column name referenced by a drizzle WHERE clause.
 *
 * Walked rather than JSON.stringify'd: a drizzle clause holds column objects that point back at
 * their table, which points at its columns — stringifying it throws on the cycle. The WeakSet is
 * what makes the walk terminate.
 */
function columnsIn(clause: unknown, seen = new WeakSet<object>()): string[] {
  if (!clause || typeof clause !== 'object' || seen.has(clause)) return [];
  seen.add(clause);
  const node = clause as Record<string, unknown>;
  const here = typeof node.name === 'string' && typeof node.columnType === 'string' ? [node.name] : [];
  const nested = Object.values(node).flatMap((v) => columnsIn(v, seen));
  return [...here, ...nested];
}

function fakeDb(opts: { lead?: Record<string, unknown> | null; convos?: { id: string }[]; bookings?: Record<string, unknown>[] } = {}) {
  const deletes: { table: unknown; order: number }[] = [];
  const wheres: unknown[] = [];
  let order = 0;

  const selectFrom = (table: unknown) => {
    if (table === leads) return opts.lead === null ? [] : [opts.lead ?? { id: LEAD, name: 'דנה', tenantId: TENANT }];
    if (table === conversations) return opts.convos ?? [{ id: 'convo-1' }];
    if (table === scheduledCalls) return opts.bookings ?? [];
    return [];
  };

  const tx = {
    delete: (table: unknown) => {
      deletes.push({ table, order: order++ });
      return {
        where: (cond: unknown) => {
          wheres.push(cond);
          const p: any = Promise.resolve([]);
          p.returning = () => Promise.resolve([{ id: 'm1' }, { id: 'm2' }]);
          return p;
        },
      };
    },
  };

  const db = {
    select: () => ({
      from: (table: unknown) => {
        const rows = selectFrom(table);
        const chain: any = {
          where: () => chain,
          limit: () => Promise.resolve(rows),
          then: (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res),
        };
        return chain;
      },
    }),
    transaction: (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  } as unknown as Database;

  return { db, deletes, wheres };
}

describe('LeadService.delete', () => {
  it('deletes children before the lead, in dependency order', async () => {
    // Reverse this order and the first DELETE fails on a foreign key, leaving everything in place.
    const { db, deletes } = fakeDb();
    await new LeadService(db).delete(TENANT, LEAD);

    const tables = deletes.sort((a, b) => a.order - b.order).map((d) => d.table);
    expect(tables).toEqual([messages, scheduledCalls, conversations, leads]);
  });

  it('reports what it destroyed, since the rows are gone by the time anyone asks', async () => {
    const { db } = fakeDb({ convos: [{ id: 'c1' }, { id: 'c2' }] });
    const summary = await new LeadService(db).delete(TENANT, LEAD);

    expect(summary).toMatchObject({ leadId: LEAD, conversations: 2, messages: 2 });
    // The NAME is captured before deletion. "lead.deleted 3f2a…" answers nothing six months later
    // when the row it points at no longer exists.
    expect(summary.name).toBe('דנה');
  });

  it('404s on a lead that is not this tenant\'s, rather than reporting a successful no-op', async () => {
    // Ownership is proven by SELECT, not by trusting a DELETE predicate to match zero rows. A
    // "deleted: true" for someone else's lead id would be a quiet confirmation that it existed.
    const { db, deletes } = fakeDb({ lead: null });
    await expect(new LeadService(db).delete(TENANT, LEAD)).rejects.toThrow();
    expect(deletes).toHaveLength(0);
  });

  it('skips the message delete entirely when there are no conversations', async () => {
    // `inArray(column, [])` is a SQL syntax error in some drivers and a full-table match in others.
    // Neither is acceptable when the statement in question deletes messages.
    const { db, deletes } = fakeDb({ convos: [] });
    const summary = await new LeadService(db).delete(TENANT, LEAD);

    expect(deletes.map((d) => d.table)).toEqual([scheduledCalls, conversations, leads]);
    expect(summary.messages).toBe(0);
  });

  it('surfaces reminder job ids so the caller can cancel them', async () => {
    // Those jobs live in Redis. Once the scheduled_calls row is deleted, nothing else knows they
    // exist — and a reminder firing about an erased lead would send their name onward after
    // erasure, which is a privacy leak on top of a bug.
    const { db } = fakeDb({
      bookings: [
        { id: 'b1', reminders: { jobIds: ['j1', 'j2'] }, providerRef: 'gcal-event-1' },
        { id: 'b2', reminders: null, providerRef: null },
      ],
    });
    const summary = await new LeadService(db).delete(TENANT, LEAD);

    expect(summary.reminderJobIds).toEqual(['j1', 'j2']);
    expect(summary.scheduledCalls).toBe(2);
  });

  it('reports calendar events as SURVIVING rather than cancelling them', async () => {
    // Deleting a database row must not silently cancel a real meeting in a customer's diary.
    // Returning the ids makes the decision the operator's, knowingly, instead of ours, silently.
    const { db } = fakeDb({ bookings: [{ id: 'b1', reminders: null, providerRef: 'gcal-event-1' }] });
    const summary = await new LeadService(db).delete(TENANT, LEAD);
    expect(summary.calendarEventRefs).toEqual(['gcal-event-1']);
  });

  it('scopes every delete to the tenant, not just the ownership check', async () => {
    // Defence in depth: the check proves the lead is theirs, the predicates make it impossible for
    // a bug in the check to reach another tenant's rows.
    const { db, wheres } = fakeDb({ bookings: [{ id: 'b1', reminders: null, providerRef: null }] });
    await new LeadService(db).delete(TENANT, LEAD);

    expect(wheres).toHaveLength(4); // messages, scheduledCalls, conversations, leads
    for (const clause of wheres) {
      expect(columnsIn(clause)).toContain('tenant_id');
    }
  });
});
