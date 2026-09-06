/**
 * What these pin: the service answers "which kind of nothing", never a comfortable blank; it does
 * not pull the transcript column across the wire to render a list; and a failed query fails.
 */
import { describe, it, expect, vi } from 'vitest';
import { CallReportService } from './call-report.service.js';

/**
 * A db stand-in that records the selected column set, so a test can assert what a query asked for
 * rather than only what it returned. `select()` is where the cost lives on a jsonb table.
 */
function fakeDb(rows: unknown[]) {
  const selections: Array<Record<string, unknown>> = [];
  const builder = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  const db = {
    select: vi.fn((cols: Record<string, unknown>) => {
      selections.push(cols);
      return builder;
    }),
  };
  return { db: db as never, selections, builder };
}

const ROW = {
  id: 'learning-1',
  tenantId: 'tenant-1',
  tenantName: 'ClickScales',
  room: 'room-abc',
  createdAt: new Date('2026-09-06T10:00:00.000Z'),
  durationSecs: 120,
  status: 'pending',
  outcome: null,
  recordingUrl: null,
  callReport: null,
  endReason: null,
};

describe('byLearningId', () => {
  it('returns null for an id that does not exist, so the route can 404', async () => {
    const { db } = fakeDb([]);
    expect(await new CallReportService(db).byLearningId('nope')).toBeNull();
  });

  it('says the call stored no report rather than returning an empty one', async () => {
    // Every call made before the engine started persisting reports lands here, and so does every
    // Twilio-era row. Drawing a figure strip of zeros for these is the bug this branch exists to
    // avoid: a zero reads as a measurement.
    const { db } = fakeDb([{ ...ROW, callReport: null }]);
    const env = (await new CallReportService(db).byLearningId('learning-1'))!;
    expect(env.report).toBeNull();
    expect(env.absence).toBe('no_report');
    expect(env.status).toBe('pending');
  });

  it('reports a stored recording as stored, and nothing more', async () => {
    // There is no audio route. `recordingStored` exists so the page can say the audio is with the
    // provider, never so it can offer a player that would 404.
    const { db } = fakeDb([{ ...ROW, recordingUrl: 'https://example.invalid/rec.mp3' }]);
    const env = (await new CallReportService(db).byLearningId('learning-1'))!;
    expect(env.recordingStored).toBe(true);
    expect(JSON.stringify(env)).not.toContain('example.invalid');
  });

  it('builds the view and feeds the end reason into the verdicts', async () => {
    const { db } = fakeDb([
      {
        ...ROW,
        endReason: 'meeting_booked',
        callReport: { summary: { cutOffs: 0 }, metrics: [], transcript: [] },
      },
    ]);
    const env = (await new CallReportService(db).byLearningId('learning-1'))!;
    expect(env.absence).toBeNull();
    expect(env.report!.verdicts.find((v) => v.id === 'booking_outcome')).toMatchObject({
      status: 'pass',
    });
  });

  it('lets a failed query fail instead of reporting it as a call with no data', async () => {
    const { db, builder } = fakeDb([]);
    builder.limit.mockRejectedValueOnce(new Error('connection reset'));
    await expect(new CallReportService(db).byLearningId('learning-1')).rejects.toThrow(
      'connection reset',
    );
  });
});

describe('listRecent', () => {
  it('asks the database whether a report exists instead of fetching it', async () => {
    const { db, selections } = fakeDb([]);
    await new CallReportService(db).listRecent({});
    const cols = Object.keys(selections[0]!);
    expect(cols).toContain('hasReport');
    // Selecting the jsonb itself would drag 50 transcripts across the wire to answer a yes/no.
    expect(cols).not.toContain('callReport');
  });

  it('clamps a limit someone typed into the query string', async () => {
    const { db, builder } = fakeDb([]);
    const svc = new CallReportService(db);
    await svc.listRecent({ limit: 9999 });
    expect(builder.limit).toHaveBeenCalledWith(200);
    await svc.listRecent({ limit: 0 });
    expect(builder.limit).toHaveBeenCalledWith(1);
    await svc.listRecent({});
    expect(builder.limit).toHaveBeenCalledWith(50);
  });

  it('keeps both filters when both are asked for', async () => {
    // The earlier draft of this branched on filter count and dropped both when there were two.
    const { db, builder } = fakeDb([]);
    await new CallReportService(db).listRecent({ tenantId: 't1', withReportOnly: true });
    expect(builder.where).toHaveBeenCalledTimes(1);
    expect(builder.where.mock.calls[0]![0]).toBeDefined();
  });

  it('passes no predicate at all when nothing was filtered', async () => {
    const { db, builder } = fakeDb([]);
    await new CallReportService(db).listRecent({});
    expect(builder.where.mock.calls[0]![0]).toBeUndefined();
  });
});
