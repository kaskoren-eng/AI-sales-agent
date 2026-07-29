import { describe, expect, it } from 'vitest';
import {
  resolveCrmSyncSettings,
  resolveLeadStatusForOutcome,
  DEFAULT_OUTCOME_STATUS_MAP,
} from './crm-sync.settings.js';

describe('resolveCrmSyncSettings', () => {
  it('defaults to enabled + pushSummary on empty settings', () => {
    const s = resolveCrmSyncSettings({});
    expect(s.enabled).toBe(true);
    expect(s.pushSummary).toBe(true);
    expect(s.statusMap).toEqual({});
    expect(s.monday.statusLabels).toEqual({});
    expect(s.airtable.statusValues).toEqual({});
  });

  it('only turns enabled/pushSummary off on an explicit false', () => {
    expect(resolveCrmSyncSettings({ crm_sync: { enabled: false } }).enabled).toBe(false);
    expect(resolveCrmSyncSettings({ crm_sync: { pushSummary: false } }).pushSummary).toBe(false);
    // garbage is not "false"
    expect(resolveCrmSyncSettings({ crm_sync: { enabled: 'no' } }).enabled).toBe(true);
  });

  it('reads per-tenant label + field maps', () => {
    const s = resolveCrmSyncSettings({
      crm_sync: {
        monday: { statusLabels: { qualified: 'Hot Lead', disqualified: 'Not a fit' } },
        airtable: { statusFieldName: 'Stage', summaryFieldName: 'Call Notes', statusValues: { qualified: 'Won' } },
      },
    });
    expect(s.monday.statusLabels.qualified).toBe('Hot Lead');
    expect(s.airtable.statusFieldName).toBe('Stage');
    expect(s.airtable.summaryFieldName).toBe('Call Notes');
    expect(s.airtable.statusValues.qualified).toBe('Won');
  });

  it('drops non-string label values defensively', () => {
    const s = resolveCrmSyncSettings({ crm_sync: { monday: { statusLabels: { qualified: 5, disqualified: 'ok' } } } });
    expect(s.monday.statusLabels).toEqual({ disqualified: 'ok' });
  });
});

describe('resolveLeadStatusForOutcome', () => {
  const base = resolveCrmSyncSettings({});

  it('uses the code defaults', () => {
    expect(resolveLeadStatusForOutcome('meeting_booked', base)).toBe('qualified');
    expect(resolveLeadStatusForOutcome('not_qualified', base)).toBe('disqualified');
    expect(resolveLeadStatusForOutcome('not_interested', base)).toBe('disqualified');
    expect(resolveLeadStatusForOutcome('callback_requested', base)).toBe('contacted');
    expect(resolveLeadStatusForOutcome('opt_out', base)).toBe('opted_out');
  });

  it('returns null for outcomes that do not move the pipeline', () => {
    expect(resolveLeadStatusForOutcome('wrong_person', base)).toBeNull();
    expect(resolveLeadStatusForOutcome('bad_time', base)).toBeNull();
    expect(resolveLeadStatusForOutcome('other', base)).toBeNull();
    expect(resolveLeadStatusForOutcome(undefined, base)).toBeNull();
  });

  it('lets a per-tenant override win over the default', () => {
    const s = resolveCrmSyncSettings({ crm_sync: { statusMap: { meeting_booked: 'contacted' } } });
    expect(resolveLeadStatusForOutcome('meeting_booked', s)).toBe('contacted');
  });

  it('lets a per-tenant null suppress a default mapping', () => {
    const s = resolveCrmSyncSettings({ crm_sync: { statusMap: { callback_requested: null } } });
    expect(resolveLeadStatusForOutcome('callback_requested', s)).toBeNull();
  });

  it('the default map is exactly the five moving outcomes', () => {
    expect(Object.keys(DEFAULT_OUTCOME_STATUS_MAP).sort()).toEqual(
      ['callback_requested', 'meeting_booked', 'not_interested', 'not_qualified', 'opt_out'].sort(),
    );
  });
});
