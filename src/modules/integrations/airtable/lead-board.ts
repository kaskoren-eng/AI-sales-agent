/**
 * ClickScales' OWN sales lead board — Airtable base `app7IOcK9NvTvHyBm`, table "לידים"
 * (`tblP4AW6CQLxZVO1P`).
 *
 * This is NOT the per-tenant Airtable integration (`tenants.settings.airtable`, see
 * `crm-sync.service.ts` and the `update_airtable` flow step). It is a platform-level,
 * one-way push of newly created leads onto Koren's sales pipeline board, scoped to
 * `PLATFORM_TENANT_ID` and configured entirely through `AIRTABLE_LEADS_*` env vars.
 *
 * Keys are FIELD IDS, not names. The board is bilingual and Koren renames columns; field
 * ids never change. Same reasoning for the single-select CHOICE ids.
 *
 * `AirtableService.createRecord` sends no `typecast`, so every select value here must be an
 * id that already exists on the board — an unknown one is a 422, not a silently created
 * choice. That is the safer failure: a wrong value is loud instead of polluting the board.
 */

/** Field ids on `tblP4AW6CQLxZVO1P`. Names in comments are the current human labels. */
export const LEAD_BOARD_FIELDS = {
  lead: 'fldci8KaHV2SWu5lC', // "Lead" (primary, singleLineText)
  email: 'fld6jrYsGvihUWjLt', // "אימייל | Email"
  phone: 'fldDbl8EDiNyoLIOf', // "מספר טלפון | Phone"
  status: 'fldG1bFOUGw6Zhf6S', // "סטטוס | Status" (singleSelect)
  stage: 'fldO39Gg4PTXinfUc', // "Stage | קבוצה" (singleSelect)
  source: 'fldhjiGqd3rddUW2e', // "מקור | Source" (singleSelect)
  sourceRaw: 'fldxeLakkvnNMBIAn', // "Lead Source (Raw)"
  adName: 'fldQcujulpBmdzUAU', // "Ad Name"
  campaignName: 'fldRl5yBaYyX0IHUk', // "Campaign Name"
  adsetName: 'fldHdLSbO2xu5gN4h', // "Adset Name"
  fbclid: 'fldfTE61e7V6yTnUQ', // "Facebook fbclid"
  facebookLeadId: 'fldAjNYhoM4Flnn8n', // "Facebook Lead ID"
  approvedMailing: 'fldUszym4ylG80Vg3', // "אישר דיוור | Approved Mailing" (checkbox)
} as const;

/**
 * Deliberately NOT written by this integration — they are the sales team's columns:
 * `אחראי | Responsible`, `פולואפ | Follow-up`, `הערות | Notes`,
 * `שווי חודשי מוערך | Est. Monthly Value`, `שיחת דמו`. And `תאריך כניסה` is a
 * `createdTime` field, which Airtable fills itself and rejects writes to.
 */

/**
 * Choice values for the three single-selects we set.
 *
 * These are choice NAMES, not ids — verified against the live base: a write of
 * `{ id: 'sel…' }` comes back `422 INVALID_VALUE_FOR_COLUMN`. Airtable only accepts the id
 * form on reads. The ids are recorded beside each one so a renamed choice can be traced back.
 *
 * Consequence to accept: renaming a choice on the board breaks the push with a 422 until this
 * file follows. That is the intended failure — the alternative is `typecast: true`, which would
 * silently CREATE the missing choice and quietly grow a second "New" column option nobody meant.
 */
export const LEAD_BOARD_CHOICES = {
  statusNew: 'New', // seltCGj8LyJjfHnGk
  stageNewLeads: 'לידים חדשים | New Leads', // sel0TKsCe0HIczn5x
  sourceFacebook: 'Facebook', // selvikEPjvmc4GDNd
  sourceGoogle: 'Google', // selpYJIchNU7lUbw6
  sourceOrganic: 'Organic', // selgvN0wASKb294q9
} as const;

/**
 * Where the board record id is cached on the lead, so a retried job cannot create a second row.
 *
 * NOT `airtableRecordId` — that key is already load-bearing for the TENANT'S OWN Airtable base
 * (`crm-sync.service.ts`, `flow-executor.worker.ts`). Two different bases, two different keys;
 * sharing one would have crm-sync patching a record id that lives somewhere else entirely.
 */
export const LEAD_BOARD_RECORD_ID_KEY = 'clickscalesLeadsRecordId';

/** The slice of a `leads` row this module needs. */
export interface LeadBoardInput {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  metadata?: unknown;
  whatsappConsent?: unknown;
}

/** utm_source values that mean "this came from Meta". Matched on the whole normalised token. */
const FACEBOOK_TOKENS = new Set(['facebook', 'fb', 'meta', 'instagram', 'ig']);
/** ...and from Google. */
const GOOGLE_TOKENS = new Set(['google', 'googleads', 'adwords', 'gads', 'youtube']);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Trim to a non-empty string, or undefined. Numbers are stringified; everything else drops. */
function text(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Which "מקור | Source" choice this lead belongs to.
 *
 * Order matters: an explicit Meta Lead Ads source beats anything in metadata, and a click id
 * (fbclid/gclid) beats a utm_source, because click ids are set by the ad platform itself while
 * utm_source is whatever the campaign builder typed.
 */
export function resolveLeadSource(lead: LeadBoardInput): string {
  const meta = asRecord(lead.metadata);

  if (lead.source === 'meta_lead_ads') return LEAD_BOARD_CHOICES.sourceFacebook;
  if (text(meta.fbclid)) return LEAD_BOARD_CHOICES.sourceFacebook;
  if (text(meta.gclid)) return LEAD_BOARD_CHOICES.sourceGoogle;

  const utm = text(meta.utm_source)?.toLowerCase();
  if (utm) {
    if (FACEBOOK_TOKENS.has(utm) || utm.includes('facebook')) return LEAD_BOARD_CHOICES.sourceFacebook;
    if (GOOGLE_TOKENS.has(utm) || utm.includes('google')) return LEAD_BOARD_CHOICES.sourceGoogle;
  }

  return LEAD_BOARD_CHOICES.sourceOrganic;
}

/**
 * Build the Airtable `fields` payload for a newly created lead.
 *
 * Absent values are OMITTED rather than sent as null or "" — an empty cell on the board reads
 * as "we never knew this", which is true, whereas an empty string reads as data.
 */
export function buildLeadBoardFields(lead: LeadBoardInput): Record<string, unknown> {
  const meta = asRecord(lead.metadata);
  const consent = asRecord(lead.whatsappConsent);

  const fields: Record<string, unknown> = {
    [LEAD_BOARD_FIELDS.status]: LEAD_BOARD_CHOICES.statusNew,
    [LEAD_BOARD_FIELDS.stage]: LEAD_BOARD_CHOICES.stageNewLeads,
    [LEAD_BOARD_FIELDS.source]: resolveLeadSource(lead),
  };

  const set = (fieldId: string, value: string | undefined) => {
    if (value !== undefined) fields[fieldId] = value;
  };

  set(LEAD_BOARD_FIELDS.lead, text(lead.name));
  set(LEAD_BOARD_FIELDS.email, text(lead.email));
  set(LEAD_BOARD_FIELDS.phone, text(lead.phone));
  // The raw string behind the single-select, so a new traffic source is still readable on the
  // board before anyone adds a choice for it.
  set(LEAD_BOARD_FIELDS.sourceRaw, text(lead.source));

  // Ad attribution. Meta's leadgen webhook carries ids (ad_id/adgroup_id), not names — the names
  // need a Graph API lookup on leadgen_id that we do not do yet, so these stay blank for Meta
  // leads. The utm_* fallbacks cover a website form that starts forwarding query params.
  set(LEAD_BOARD_FIELDS.adName, text(meta.ad_name) ?? text(meta.utm_content));
  set(LEAD_BOARD_FIELDS.campaignName, text(meta.campaign_name) ?? text(meta.utm_campaign));
  set(LEAD_BOARD_FIELDS.adsetName, text(meta.adset_name));
  set(LEAD_BOARD_FIELDS.fbclid, text(meta.fbclid));
  set(LEAD_BOARD_FIELDS.facebookLeadId, text(meta.leadgen_id));

  // Only ever ticked, never explicitly unticked: an unchecked box on a brand-new row already
  // means "no consent recorded", and writing `false` would look like a decision we did not make.
  if (consent.granted === true) fields[LEAD_BOARD_FIELDS.approvedMailing] = true;

  return fields;
}
