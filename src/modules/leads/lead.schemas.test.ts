import { describe, it, expect } from 'vitest';
import { createLeadSchema, updateLeadSchema } from './lead.schemas.js';

describe('createLeadSchema', () => {
  it('accepts valid input', () => {
    const result = createLeadSchema.parse({
      name: 'John Doe',
      email: 'john@example.com',
      phone: '+1234567890',
      source: 'whatsapp',
    });
    expect(result.name).toBe('John Doe');
  });

  it('accepts empty object (all fields optional)', () => {
    const result = createLeadSchema.parse({});
    expect(result).toEqual({});
  });

  it('rejects invalid email', () => {
    expect(() => createLeadSchema.parse({ email: 'not-an-email' })).toThrow();
  });

  it('rejects invalid source', () => {
    expect(() => createLeadSchema.parse({ source: 'carrier_pigeon' })).toThrow();
  });

  it('accepts metadata as record', () => {
    const result = createLeadSchema.parse({ metadata: { utm_source: 'google' } });
    expect(result.metadata).toEqual({ utm_source: 'google' });
  });
});

describe('updateLeadSchema', () => {
  it('accepts status field', () => {
    const result = updateLeadSchema.parse({ status: 'qualified' });
    expect(result.status).toBe('qualified');
  });

  it('accepts score', () => {
    const result = updateLeadSchema.parse({ score: 85 });
    expect(result.score).toBe(85);
  });

  it('rejects score out of range', () => {
    expect(() => updateLeadSchema.parse({ score: 101 })).toThrow();
    expect(() => updateLeadSchema.parse({ score: -1 })).toThrow();
  });

  it('rejects invalid status', () => {
    expect(() => updateLeadSchema.parse({ status: 'invalid' })).toThrow();
  });
});
