import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EVERY PLACE A LEAD IS CREATED MUST DECIDE WHETHER IT IS BILLABLE.
 *
 * There are nine `insert(leads)` sites in this codebase — API, website intake, Meta Lead Ads,
 * WhatsApp, email, CSV upload, Google Sheets, Monday, and the voice agent. There will be a tenth.
 *
 * The failure this prevents is the worst kind: SILENT UNDER-BILLING. A new lead source ships, it
 * works perfectly, leads flow, the customer is delighted — and none of it is metered. Nothing
 * errors, no alert fires, and the only symptom is an invoice that is quietly too small. Nobody
 * reports being under-charged, so it can run for months.
 *
 * A database trigger would catch all ten by construction, and was the first design. It was
 * rejected for two reasons: this suite has no Postgres, so a trigger would be UNTESTED code
 * holding up the money path; and one of the nine sites inserts the "Web simulator" placeholder
 * lead, which a blanket trigger would bill customers for. Billing someone for opening the
 * simulator to test their own agent is exactly the charge that ends a trial.
 *
 * So the rule is enforced here instead: every site either meters, or carries an explicit exemption
 * marker naming a reason. The marker matters — it distinguishes "we decided this one is not
 * billable" from "we forgot", and only the second is a bug.
 */

const EXEMPT_MARKER = 'usage-metering: exempt';
const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** How far from the insert we look for the meter call or the exemption. */
const WINDOW_BEFORE = 12;
const WINDOW_AFTER = 20;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'migrations' || entry === '__fixtures__') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface Site {
  file: string;
  line: number;
  metered: boolean;
  exempt: boolean;
}

function findLeadInsertSites(): Site[] {
  const sites: Site[] = [];

  for (const file of walk(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      // `.insert(leads)` — the drizzle idiom used by every one of the current nine.
      if (!/\.insert\(\s*leads\s*\)/.test(text)) return;

      const window = lines.slice(Math.max(0, i - WINDOW_BEFORE), i + WINDOW_AFTER).join('\n');
      sites.push({
        file: relative(SRC, file).replace(/\\/g, '/'),
        line: i + 1,
        metered: /meterLead\s*\(/.test(window),
        exempt: window.includes(EXEMPT_MARKER),
      });
    });
  }

  return sites;
}

describe('lead metering coverage', () => {
  const sites = findLeadInsertSites();

  it('finds the lead-creation sites at all (the scanner itself must not silently break)', () => {
    // If a refactor changes the drizzle idiom, this whole test would pass vacuously while covering
    // nothing — which is worse than not having it, because it reads as a guarantee.
    expect(sites.length).toBeGreaterThanOrEqual(8);
  });

  it('every lead-creation site either meters or is explicitly exempt', () => {
    const undecided = sites.filter((s) => !s.metered && !s.exempt);

    expect(
      undecided,
      undecided.length === 0
        ? ''
        : `\n\nThese sites create a lead without metering it, and without saying why:\n` +
          undecided.map((s) => `  • ${s.file}:${s.line}`).join('\n') +
          `\n\nA lead created here would never appear on an invoice, and nothing would ever report it.\n` +
          `Either call meterLead(db, { tenantId, leadId, source }) after the insert, or — if this\n` +
          `row is plumbing rather than a real lead — add a comment containing "${EXEMPT_MARKER}"\n` +
          `with the reason.\n`,
    ).toEqual([]);
  });

  it('the exempt sites are the two we decided on, and no more', () => {
    // Pinned by path so a new exemption is a deliberate edit to this list, reviewed on its own
    // merits, rather than a marker quietly added to make a failing test go away.
    const exempt = sites.filter((s) => s.exempt).map((s) => s.file).sort();
    expect(exempt).toEqual([
      // The calls list inner-joins a lead, so a browser simulator session needs a row to point at.
      'modules/channels/voice-livekit/call-record.ts',
      // A do-not-contact record. Someone who says "take me off your list" is not a billable lead.
      'modules/channels/voice-livekit/tools/end-call.tool.ts',
    ]);
  });
});
