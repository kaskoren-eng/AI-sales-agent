import type { LeadStatus } from '../leads/lead-status.js';

/**
 * Per-tenant CRM-sync configuration (`tenants.settings.crm_sync`).
 *
 * Connection credentials live elsewhere (`settings.monday`, `settings.airtable`); this key holds
 * only the BEHAVIOR of the after-call sync: whether it runs, how a call outcome maps to a pipeline
 * status, and — because every business labels their CRM columns differently — how OUR canonical
 * status maps to the tenant's actual CRM column value.
 */
export interface CrmSyncSettings {
  /** Master switch. Default on — a connected CRM should sync unless the tenant opts out. */
  enabled: boolean;
  /** Push the GPT call summary as a note/field (Workstream B2). Default on. */
  pushSummary: boolean;
  /**
   * Outcome → canonical lead status. Overrides the code defaults below. A value of `null` means
   * "recognized outcome, but do NOT change the status" (e.g. a tenant who doesn't want
   * callback_requested to move the lead). Unknown outcomes fall through to no change.
   */
  statusMap: Record<string, LeadStatus | null>;
  monday: {
    /** Canonical status → the label text of the tenant's Monday status column. */
    statusLabels: Record<string, string>;
  };
  airtable: {
    /** The tenant's Airtable field that holds pipeline status (e.g. "Stage"). */
    statusFieldName?: string;
    /** The tenant's Airtable long-text field for the call summary (e.g. "Call Notes"). */
    summaryFieldName?: string;
    /** Canonical status → the option value in the Airtable status field. */
    statusValues: Record<string, string>;
  };
}

/**
 * The call outcome Keren records (`analysis.end_reason`, from the end_call tool's reason enum) →
 * canonical pipeline status. `opt_out` is already applied live on the call (end-call tool flips the
 * lead to opted_out immediately); it's mapped here too so the CRM push is idempotent and correct.
 * wrong_person / bad_time / other intentionally have no mapping — they don't move the pipeline.
 */
export const DEFAULT_OUTCOME_STATUS_MAP: Record<string, LeadStatus> = {
  meeting_booked: 'qualified',
  not_qualified: 'disqualified',
  not_interested: 'disqualified',
  callback_requested: 'contacted',
  opt_out: 'opted_out',
};

const DEFAULTS: CrmSyncSettings = {
  enabled: true,
  pushSummary: true,
  statusMap: {},
  monday: { statusLabels: {} },
  airtable: { statusValues: {} },
};

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** A string→string map from raw settings, dropping any non-string values. */
function asStringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(asObject(v))) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

/**
 * Merge the tenant's `crm_sync` settings over the code defaults. Tolerant of garbage — a malformed
 * key falls back to its default rather than throwing (this runs in a background worker, never
 * interactively). `enabled`/`pushSummary` default TRUE and are only turned off by an explicit
 * `false`.
 */
export function resolveCrmSyncSettings(rawTenantSettings: unknown): CrmSyncSettings {
  const raw = asObject(asObject(rawTenantSettings).crm_sync);

  // statusMap: keep string values (a status) and explicit null ("no change"); drop anything else.
  const statusMap: Record<string, LeadStatus | null> = {};
  for (const [outcome, val] of Object.entries(asObject(raw.statusMap))) {
    if (val === null) statusMap[outcome] = null;
    else if (typeof val === 'string') statusMap[outcome] = val as LeadStatus;
  }

  const monday = asObject(raw.monday);
  const airtable = asObject(raw.airtable);

  return {
    enabled: raw.enabled === false ? false : DEFAULTS.enabled,
    pushSummary: raw.pushSummary === false ? false : DEFAULTS.pushSummary,
    statusMap,
    monday: { statusLabels: asStringMap(monday.statusLabels) },
    airtable: {
      statusFieldName: typeof airtable.statusFieldName === 'string' ? airtable.statusFieldName : undefined,
      summaryFieldName: typeof airtable.summaryFieldName === 'string' ? airtable.summaryFieldName : undefined,
      statusValues: asStringMap(airtable.statusValues),
    },
  };
}

/**
 * Resolve a call outcome to the canonical lead status to move to — or `null` for "no status
 * change" (unknown/unmapped outcome, or a tenant override that set it to null). The per-tenant
 * override wins over the default map; an override present as `null` suppresses a default mapping.
 */
export function resolveLeadStatusForOutcome(
  endReason: string | undefined,
  settings: CrmSyncSettings,
): LeadStatus | null {
  if (!endReason) return null;
  if (Object.prototype.hasOwnProperty.call(settings.statusMap, endReason)) {
    return settings.statusMap[endReason];
  }
  return DEFAULT_OUTCOME_STATUS_MAP[endReason] ?? null;
}
