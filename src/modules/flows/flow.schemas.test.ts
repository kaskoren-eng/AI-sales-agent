import { describe, it, expect } from 'vitest';
import { flowDefinitionSchema } from './flow.schemas.js';

describe('flowDefinitionSchema', () => {
  it('accepts a valid whatsapp flow', () => {
    const result = flowDefinitionSchema.parse({
      enabled: true,
      steps: [
        {
          type: 'send_whatsapp',
          delayMinutes: 0,
          content: { messageType: 'text', text: 'Hello!' },
        },
      ],
    });
    expect(result.enabled).toBe(true);
    expect(result.steps).toHaveLength(1);
  });

  it('accepts a call step', () => {
    const result = flowDefinitionSchema.parse({
      enabled: true,
      steps: [{ type: 'make_call', delayMinutes: 5 }],
    });
    expect(result.steps[0].type).toBe('make_call');
  });

  it('accepts mixed steps', () => {
    const result = flowDefinitionSchema.parse({
      enabled: false,
      steps: [
        { type: 'send_whatsapp', delayMinutes: 0, content: { messageType: 'video', url: 'https://example.com/v.mp4', caption: 'Watch this' } },
        { type: 'make_call', delayMinutes: 30 },
        { type: 'send_whatsapp', delayMinutes: 60, content: { messageType: 'text', text: 'Follow up' } },
      ],
    });
    expect(result.steps).toHaveLength(3);
  });

  it('rejects empty steps', () => {
    expect(() => flowDefinitionSchema.parse({ enabled: true, steps: [] })).toThrow();
  });

  it('rejects delay > 7 days', () => {
    expect(() =>
      flowDefinitionSchema.parse({
        enabled: true,
        steps: [{ type: 'make_call', delayMinutes: 10081 }],
      })
    ).toThrow();
  });

  it('rejects unknown step type', () => {
    expect(() =>
      flowDefinitionSchema.parse({
        enabled: true,
        steps: [{ type: 'send_sms', delayMinutes: 0 }],
      })
    ).toThrow();
  });
});
