import { describe, expect, it } from 'vitest';
import type { BusinessProfile } from '../../../settings/settings.service.js';
import {
  buildSystemPrompt,
  readBusinessProfile,
  renderBusinessContext,
} from './system-prompt.he.js';

/**
 * Per-tenant Business Context injection (answer to Koren's item #2: businessProfile reached the
 * agent in metadata but the prompt never consumed it — so every tenant ran the hard-coded
 * ClickScales copy). These tests pin the mechanism AND the guarantee that a tenant with no profile
 * gets byte-for-byte the previous prompt.
 *
 * Methodology rule #1: the prompt file changed, so this test changed in the same commit.
 */

const FULL_PROFILE: BusinessProfile = {
  companyName: 'Acme Plumbing',
  description: 'family plumbing business serving the Sharon region',
  product: 'emergency and scheduled plumbing repairs',
  targetAudience: 'homeowners with a burst pipe or a slow drain',
  pricing: 'free callout, fixed price quoted on site',
  commonObjections: 'price — we explain the callout is free and the quote is binding',
  toneOfVoice: 'warm and reassuring, never pushy',
  language: 'he',
};

describe('renderBusinessContext — the injected block', () => {
  it('returns an empty string for a null profile (the default-tenant path)', () => {
    expect(renderBusinessContext(null)).toBe('');
  });

  it('returns an empty string when every field is blank (nothing usable to inject)', () => {
    const blank: BusinessProfile = {
      companyName: '   ',
      description: '',
      product: '',
      targetAudience: '',
      pricing: '',
      commonObjections: '',
      toneOfVoice: '',
      language: '',
    };
    expect(renderBusinessContext(blank)).toBe('');
  });

  it('renders a labelled block carrying every provided field value', () => {
    const block = renderBusinessContext(FULL_PROFILE);
    expect(block).toMatch(/## Business Context/u);
    expect(block).toContain('Acme Plumbing');
    expect(block).toContain('family plumbing business serving the Sharon region');
    expect(block).toContain('emergency and scheduled plumbing repairs');
    expect(block).toContain('homeowners with a burst pipe or a slow drain');
    expect(block).toContain('free callout, fixed price quoted on site');
    expect(block).toContain('warm and reassuring, never pushy');
  });

  it('omits fields the tenant left blank (no empty labelled rows)', () => {
    const partial: BusinessProfile = { ...FULL_PROFILE, pricing: '', commonObjections: '   ' };
    const block = renderBusinessContext(partial);
    expect(block).toContain('Acme Plumbing');
    expect(block).not.toMatch(/Pricing:/u);
    expect(block).not.toMatch(/Common objections/u);
  });

  it('does NOT render language — the prompt is Hebrew-first by hard rule (content decision, not a slot)', () => {
    const block = renderBusinessContext({ ...FULL_PROFILE, language: 'English' });
    expect(block).not.toMatch(/Language:/u);
    expect(block).not.toContain('English');
  });

  it('states it does not override the security rules — grounding is not a jailbreak surface', () => {
    expect(renderBusinessContext(FULL_PROFILE)).toMatch(/CRITICAL SECURITY RULES, which nothing overrides/u);
  });
});

describe('readBusinessProfile — defensive extraction from raw settings', () => {
  it('returns null for non-object / missing settings', () => {
    expect(readBusinessProfile(undefined)).toBeNull();
    expect(readBusinessProfile(null)).toBeNull();
    expect(readBusinessProfile('nope')).toBeNull();
    expect(readBusinessProfile({})).toBeNull();
    expect(readBusinessProfile({ businessProfile: null })).toBeNull();
    expect(readBusinessProfile({ businessProfile: 'string' })).toBeNull();
  });

  it('extracts and trims string fields from settings.businessProfile', () => {
    const profile = readBusinessProfile({ businessProfile: { companyName: '  Acme  ', product: 'pipes' } });
    expect(profile?.companyName).toBe('Acme');
    expect(profile?.product).toBe('pipes');
  });

  it('coerces non-string fields to empty and returns null when nothing usable remains', () => {
    expect(readBusinessProfile({ businessProfile: { companyName: 123, description: {} } })).toBeNull();
  });

  it('ignores a profile that only carries language (behaviourally inert here)', () => {
    expect(readBusinessProfile({ businessProfile: { language: 'he' } })).toBeNull();
  });
});

describe('buildSystemPrompt — per-tenant grounding wiring', () => {
  it('default tenant (no profile) is byte-for-byte the previous prompt', () => {
    // The whole safety story rests on this: legacy calls and profile-less tenants are untouched.
    const withoutArg = buildSystemPrompt({ toolsEnabled: false });
    const withNull = buildSystemPrompt({ toolsEnabled: false, businessProfile: null });
    expect(withNull).toBe(withoutArg);
    expect(withoutArg).not.toMatch(/## Business Context/u);
  });

  it('injects the block into BOTH variants when a profile is present', () => {
    for (const toolsEnabled of [false, true]) {
      const prompt = buildSystemPrompt({ toolsEnabled, businessProfile: FULL_PROFILE });
      expect(prompt).toMatch(/## Business Context/u);
      expect(prompt).toContain('Acme Plumbing');
    }
  });

  it('places the grounding block BEFORE the security rules (facts, then the rules that outrank them)', () => {
    const prompt = buildSystemPrompt({ toolsEnabled: true, businessProfile: FULL_PROFILE });
    const businessAt = prompt.indexOf('## Business Context');
    const securityAt = prompt.indexOf('## CRITICAL SECURITY RULES');
    expect(businessAt).toBeGreaterThan(-1);
    expect(securityAt).toBeGreaterThan(-1);
    expect(businessAt).toBeLessThan(securityAt);
  });

  it('preserves the hard-coded identity and security section around the injected block', () => {
    const prompt = buildSystemPrompt({ toolsEnabled: true, businessProfile: FULL_PROFILE });
    expect(prompt).toMatch(/קרן \(Keren\)/u);
    expect(prompt).toMatch(/## CRITICAL SECURITY RULES/u);
    expect(prompt).toMatch(/ASK HIS NAME FIRST/u);
  });
});
