import { describe, expect, it, vi } from 'vitest';
import { CallsService } from './calls.service.js';
import { conversations, messages, callLearnings } from '../../db/schema/index.js';

/**
 * ERASING A CALL.
 *
 * A call is the densest personal data this system holds — a recorded human voice is biometric data
 * and the transcript is everything the person said. `docs/legal-drafts/` promises deletion on
 * request; nothing implemented it, so the honest answer was a hand-written SQL statement.
 *
 * What these tests defend, in order of how badly each would go wrong:
 *
 *   • THE LEAD SURVIVES. Someone asking to erase one recording has not asked to be forgotten
 *     entirely. Taking their whole record and every other conversation with it is a destructive
 *     over-reach that no response body would make acceptable.
 *   • `call_learnings` IS MATCHED ON A STRING, not a foreign key — the room name. With a null room
 *     name, an unconstrained delete would take every learnings row whose conference_name is null.
 *   • WHAT SURVIVES IS SAID OUT LOUD. The audio lives with the provider and this code cannot reach
 *     it, so "deleted: true" must not be allowed to imply an erasure that did not happen.
 */

const TENANT = 'tenant-1';
const CALL = 'convo-1';

function fakeService(opts: { row?: Record<string, unknown> | null } = {}) {
  const deletes: { table: unknown; order: number }[] = [];
  let order = 0;

  const row =
    opts.row === null ? undefined : opts.row ?? { id: CALL, channelRef: 'room-abc', channel: 'voice' };

  const tx = {
    delete: (table: unknown) => {
      deletes.push({ table, order: order++ });
      return {
        where: () => {
          const p: any = Promise.resolve([]);
          p.returning = () =>
            Promise.resolve(
              table === callLearnings
                ? [{ id: 'cl1', recordingUrl: 'https://provider/rec1.wav' }]
                : [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
            );
          return p;
        },
      };
    },
  };

  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }) }),
    }),
    transaction: (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  };

  const service = new CallsService({
    db: db as never,
    redis: {} as never,
    env: {} as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });

  return { service, deletes };
}

describe('CallsService.deleteCall', () => {
  it('deletes the transcript, the analysis and the messages — and NOT the lead', async () => {
    const { service, deletes } = fakeService();
    const summary = await service.deleteCall(TENANT, CALL);

    const tables = deletes.sort((a, b) => a.order - b.order).map((t) => t.table);
    expect(tables).toEqual([callLearnings, messages, conversations]);
    // The lead is not in that list, and that is the assertion. Erasing one recording must not
    // destroy the person's record and every other conversation with them.
    expect(summary).toMatchObject({ callId: CALL, messages: 3, learnings: 1 });
  });

  it('reports the recording as NOT deleted, because it lives with the provider', async () => {
    // "deleted: true" with the audio still sitting in provider storage would be a false statement
    // to a person who asked to be erased — the worst kind of bug here, because it looks like success.
    const { service } = fakeService();
    const summary = await service.deleteCall(TENANT, CALL);
    expect(summary!.recordingRefs).toEqual(['https://provider/rec1.wav']);
  });

  it('never issues an unconstrained learnings delete when the room name is null', async () => {
    // `call_learnings` joins on conference_name, a plain string. `eq(col, null)` does not match
    // null rows in SQL, but the shape of the bug is worse than that: a code path that builds this
    // predicate from a null would be one refactor away from deleting every tenant's null-named
    // learnings. Skipping it entirely is the only safe answer.
    const { service, deletes } = fakeService({ row: { id: CALL, channelRef: null, channel: 'voice' } });
    const summary = await service.deleteCall(TENANT, CALL);

    expect(deletes.map((d) => d.table)).toEqual([messages, conversations]);
    expect(summary!.learnings).toBe(0);
  });

  it('returns null for another tenant\'s call, so the route can 404 instead of confirming it exists', async () => {
    const { service, deletes } = fakeService({ row: null });
    expect(await service.deleteCall(TENANT, CALL)).toBeNull();
    expect(deletes).toHaveLength(0);
  });

  it('refuses to delete a non-voice conversation through the calls endpoint', async () => {
    // A WhatsApp thread is not a call. Deleting one here would erase a conversation the caller
    // never asked about, through an endpoint whose name says otherwise.
    const { service, deletes } = fakeService({ row: { id: CALL, channelRef: 'x', channel: 'whatsapp' } });
    expect(await service.deleteCall(TENANT, CALL)).toBeNull();
    expect(deletes).toHaveLength(0);
  });
});
