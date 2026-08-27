import { describe, it, expect } from 'vitest';
import {
  buildLeadBoardFields,
  resolveLeadSource,
  LEAD_BOARD_FIELDS as F,
  LEAD_BOARD_CHOICES as C,
} from './lead-board.js';

const base = {
  name: 'Dana Levi',
  email: 'dana@example.com',
  phone: '+972501234567',
  source: 'clickscales.com',
  metadata: {},
  whatsappConsent: null,
};

describe('resolveLeadSource', () => {
  it('reads Meta Lead Ads leads as Facebook', () => {
    expect(resolveLeadSource({ ...base, source: 'meta_lead_ads' })).toBe(C.sourceFacebook);
  });

  it('lets a click id outrank utm_source', () => {
    // fbclid is stamped by the ad platform; utm_source is whatever the campaign builder typed.
    expect(
      resolveLeadSource({ ...base, metadata: { fbclid: 'IwAR123', utm_source: 'newsletter' } }),
    ).toBe(C.sourceFacebook);
    expect(
      resolveLeadSource({ ...base, metadata: { gclid: 'Cj0KC', utm_source: 'newsletter' } }),
    ).toBe(C.sourceGoogle);
  });

  it('maps the usual utm_source spellings', () => {
    for (const utm of ['facebook', 'FB', 'instagram', 'ig', 'meta', 'facebook_ads']) {
      expect(resolveLeadSource({ ...base, metadata: { utm_source: utm } })).toBe(C.sourceFacebook);
    }
    for (const utm of ['google', 'adwords', 'googleads', 'Google Ads']) {
      expect(resolveLeadSource({ ...base, metadata: { utm_source: utm } })).toBe(C.sourceGoogle);
    }
  });

  it('does not match a token hiding inside an unrelated word', () => {
    // 'ig' is a Facebook token, but "digital-newsletter" is not Instagram traffic. Whole-token
    // matching is the point; a substring test would have filed this under Facebook.
    expect(resolveLeadSource({ ...base, metadata: { utm_source: 'digital-newsletter' } })).toBe(
      C.sourceOrganic,
    );
  });

  it('falls back to Organic', () => {
    expect(resolveLeadSource(base)).toBe(C.sourceOrganic);
    expect(resolveLeadSource({ ...base, metadata: null })).toBe(C.sourceOrganic);
  });
});

describe('buildLeadBoardFields', () => {
  it('always stamps Status, Stage and Source', () => {
    const fields = buildLeadBoardFields(base);
    expect(fields[F.status]).toBe(C.statusNew);
    expect(fields[F.stage]).toBe(C.stageNewLeads);
    expect(fields[F.source]).toBe(C.sourceOrganic);
  });

  it('writes select values as plain strings, never as { id } objects', () => {
    // Proven against the live base: `{ id: 'sel…' }` is rejected with
    // 422 INVALID_VALUE_FOR_COLUMN. Airtable accepts the id form on reads only. This test exists
    // so the next person who "fixes" these into ids gets a red test instead of a silent 422 in
    // production, where the only symptom is rows quietly not appearing on the board.
    const fields = buildLeadBoardFields(base);
    for (const fieldId of [F.status, F.stage, F.source]) {
      expect(typeof fields[fieldId]).toBe('string');
    }
  });

  it('maps name, email and phone onto the board field ids', () => {
    const fields = buildLeadBoardFields(base);
    expect(fields[F.lead]).toBe('Dana Levi');
    expect(fields[F.email]).toBe('dana@example.com');
    expect(fields[F.phone]).toBe('+972501234567');
    expect(fields[F.sourceRaw]).toBe('clickscales.com');
  });

  it('OMITS absent values rather than sending empty strings', () => {
    // A blank cell means "we never knew this". An empty string means "we asked and it was blank",
    // which is a different and wrong claim to make on a sales board.
    const fields = buildLeadBoardFields({ name: null, email: undefined, phone: '   ', source: null });
    expect(Object.keys(fields)).toEqual([F.status, F.stage, F.source]);
  });

  it('never writes the sales team\u2019s own columns', () => {
    const written = new Set(Object.keys(buildLeadBoardFields({ ...base, metadata: { fbclid: 'x' } })));
    for (const untouched of [
      'fldz88G9renfch85w', // תאריך כניסה (createdTime — Airtable rejects writes)
      'fldQEFrGn2M12b8p8', // אחראי | Responsible
      'fldP8mvuH7zvaPzM5', // פולואפ | Follow-up
      'fldHuckf3mC5qK2ce', // הערות | Notes
      'fldCHLQ1Vx2N4DsZB', // שווי חודשי מוערך
      'fldddGTpxpzxnAiLU', // שיחת דמו
    ]) {
      expect(written.has(untouched)).toBe(false);
    }
  });

  it('carries Meta ad attribution when it is there', () => {
    const fields = buildLeadBoardFields({
      ...base,
      source: 'meta_lead_ads',
      metadata: {
        leadgen_id: '1234567890',
        fbclid: 'IwAR9',
        ad_name: 'Hebrew demo v3',
        campaign_name: 'Q3 SMB',
        adset_name: 'Lookalike 1%',
      },
    });
    expect(fields[F.facebookLeadId]).toBe('1234567890');
    expect(fields[F.fbclid]).toBe('IwAR9');
    expect(fields[F.adName]).toBe('Hebrew demo v3');
    expect(fields[F.campaignName]).toBe('Q3 SMB');
    expect(fields[F.adsetName]).toBe('Lookalike 1%');
    expect(fields[F.source]).toBe(C.sourceFacebook);
  });

  it('falls back to utm_* for a website lead that carries query params', () => {
    const fields = buildLeadBoardFields({
      ...base,
      metadata: { utm_campaign: 'launch-he', utm_content: 'hero-cta' },
    });
    expect(fields[F.campaignName]).toBe('launch-he');
    expect(fields[F.adName]).toBe('hero-cta');
    // No adset equivalent in UTM-land, so that column stays blank rather than guessing.
    expect(fields[F.adsetName]).toBeUndefined();
  });

  it('ticks Approved Mailing only when consent was actually granted', () => {
    expect(
      buildLeadBoardFields({ ...base, whatsappConsent: { granted: true, source: 'intake_form' } })[
        F.approvedMailing
      ],
    ).toBe(true);

    // Absent, explicitly false, and malformed all mean the same thing: no box ticked, and no
    // `false` written either — an unchecked checkbox on a new row already says it.
    for (const consent of [null, undefined, { granted: false }, { granted: 'true' }, 'yes']) {
      expect(buildLeadBoardFields({ ...base, whatsappConsent: consent })[F.approvedMailing]).toBeUndefined();
    }
  });
});
