import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A LINT, WRITTEN AS A TEST.
 *
 * Every tenant-scoped table carries `tenant_id`, and the rule is that every write filters on it.
 * The rule held everywhere except one place — the Monday webhook issued
 * `UPDATE leads WHERE id = ...` with no tenant predicate, safe only because of how the row
 * happened to be fetched three lines earlier. That is the failure mode this guards: not malice,
 * but a write that is correct today and becomes a cross-tenant bug when someone changes how its
 * subject is obtained.
 *
 * The check is deliberately crude — it reads source text and looks for `tenantId` inside the
 * statement — because a precise version needs a TypeScript AST walk, and a crude check that runs
 * on every commit beats a precise one nobody writes. False positives are handled by the
 * ACKNOWLEDGED list below, where each entry has to justify itself.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '..');

/** Tables where a row belongs to exactly one tenant. */
const TENANT_SCOPED = [
  'leads',
  'conversations',
  'messages',
  'scheduledCalls',
  'callLearnings',
  'importJobs',
  'tenantMembers',
  'auditEvents',
];

/**
 * Writes that do not currently carry a tenant predicate, with the reason each is tolerated.
 *
 * ALL of these update a row by its UUID primary key, obtained from a tenant-scoped read or a job
 * payload earlier in the same function. None is a live cross-tenant write: guessing a v4 uuid is
 * not an attack. They are on this list rather than fixed because every one of them lives in the
 * VOICE session's territory (`modules/channels/voice*`, `modules/calls/*` services, the
 * call-analysis worker) and this session does not edit those files — see the TERRITORY RULES in
 * CLAUDE.md.
 *
 * They are worth fixing when VOICE next touches them. The Monday webhook had exactly this shape,
 * was equally "safe because of how the id is obtained", and became an unauthenticated
 * cross-tenant write the moment the id started arriving in a request body.
 */
const ACKNOWLEDGED: Array<{ file: string; reason: string }> = [
  {
    file: 'modules/calls/monitor-call.service.ts',
    reason: 'VOICE territory — updates call_learnings by id from a row it just inserted',
  },
  {
    file: 'modules/channels/voice/voice.routes.ts',
    reason: 'VOICE territory — updates conversations by id resolved from the Retell call id',
  },
  {
    file: 'modules/channels/voice-livekit/stt/shadow-stt.ts',
    reason: 'VOICE territory — writes the shadow transcript by call_learnings id held in memory',
  },
  {
    file: 'queues/workers/call-analysis.worker.ts',
    reason: 'VOICE territory — marks a learning failed by the id carried in the BullMQ job',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'migrations') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Split a source file into `.update(x)` / `.delete(x)` statements — from the call to the
 * terminating semicolon — so the `.where()` that belongs to it is in scope and the next
 * statement's is not.
 */
function writeStatements(source: string): Array<{ table: string; text: string; line: number }> {
  const found: Array<{ table: string; text: string; line: number }> = [];
  const re = /\.(update|delete)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const table = m[2];
    if (!TENANT_SCOPED.includes(table)) continue;

    // To the end of the statement. Good enough: these are all fluent chains ending in `;`.
    const end = source.indexOf(';', m.index);
    const text = source.slice(m.index, end === -1 ? source.length : end);
    found.push({ table, text, line: source.slice(0, m.index).split('\n').length });
  }
  return found;
}

describe('every write to a tenant-scoped table filters by tenant', () => {
  it('finds no unscoped update or delete', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, '/');
      if (ACKNOWLEDGED.some((a) => rel === a.file)) continue;

      const source = readFileSync(file, 'utf8');
      for (const stmt of writeStatements(source)) {
        // `tenantId` in the statement means the predicate is there (`eq(x.tenantId, ...)`) or the
        // row being written is itself keyed by it.
        if (!/tenantId/.test(stmt.text)) {
          offenders.push(`${rel}:${stmt.line} — write to ${stmt.table} with no tenant predicate`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the acknowledged list stays honest', () => {
    // An exemption for a file that no longer exists is an exemption nobody is checking. This fails
    // when a path goes stale, forcing the list to be pruned rather than accumulating.
    for (const { file } of ACKNOWLEDGED) {
      expect(() => statSync(join(SRC, file)), `${file} is exempted but does not exist`).not.toThrow();
    }
  });
});
