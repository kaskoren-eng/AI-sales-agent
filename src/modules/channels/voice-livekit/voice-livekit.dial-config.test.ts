/**
 * THE OUTAGE THIS CLOSES.
 *
 * `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` was never set on the Railway service. The dialer read it,
 * found nothing, and returned `{ callId: 'skipped' }` without throwing. Nothing downstream
 * checked the shape of that result, so:
 *
 *   - the flow executor logged `event="outbound_call_placed"` on every lead, and
 *   - `POST /api/v1/calls/outbound` answered `{ ok: true, callId: 'skipped' }` to the dashboard.
 *
 * Production therefore reported placing outbound calls while dialling nothing at all. The only
 * observable symptom was a phone that did not ring — invisible in logs, invisible in the
 * dashboard, and indistinguishable from a lead who simply did not answer. It was found only when
 * someone waited for a call that never came, and it made the production call count meaningless.
 *
 * The fix is to throw. A missing trunk is a configuration failure, and a configuration failure
 * that renders as success is worse than one that renders as a dead-lettered job.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('livekit-server-sdk', () => ({
  SipClient: class {
    createSipParticipant = vi.fn().mockResolvedValue({ participantId: 'PA_x' });
  },
}));

import { LiveKitVoiceService } from './voice-livekit.service.js';

const BASE_ENV = {
  LIVEKIT_URL: 'wss://test.livekit.cloud',
  LIVEKIT_API_KEY: 'APItest',
  LIVEKIT_API_SECRET: 'secret',
};

const TENANT = '613d826c-ad00-4302-9817-1c0649ed4f98';

describe('outbound dial — a missing SIP trunk must not look like a placed call', () => {
  beforeEach(() => vi.clearAllMocks());

  it('THROWS instead of returning a success-shaped result', async () => {
    const svc = new LiveKitVoiceService({ ...BASE_ENV } as any);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      svc.initiateOutboundCall('+972509788845', TENANT, { leadId: 'lead-1' }),
    ).rejects.toMatchObject({ code: 'SIP_TRUNK_NOT_CONFIGURED', statusCode: 503 });

    err.mockRestore();
  });

  it('never resolves to the old { callId: "skipped" } shape', async () => {
    // The precise regression. Any resolved value here means the flow executor logs
    // `outbound_call_placed` and the API answers `ok: true` — the exact failure mode above.
    const svc = new LiveKitVoiceService({ ...BASE_ENV } as any);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await svc
      .initiateOutboundCall('+972509788845', TENANT)
      .then((v) => ({ resolved: v }))
      .catch(() => null);

    expect(result).toBeNull();
    err.mockRestore();
  });

  it('logs a greppable event, without the lead phone number', async () => {
    const svc = new LiveKitVoiceService({ ...BASE_ENV } as any);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await svc.initiateOutboundCall('+972509788845', TENANT, { leadId: 'lead-1' }).catch(() => {});

    const line = err.mock.calls[0]?.join(' ') ?? '';
    expect(line).toContain('dial_failed_no_trunk');
    expect(line).toContain(TENANT);
    expect(line).toContain('lead-1');
    // Never log a lead's phone number, here or anywhere.
    expect(line).not.toContain('+972509788845');

    err.mockRestore();
  });

  it('an empty-string trunk id counts as unset, not as a usable trunk', async () => {
    // Railway variables come back as empty strings when cleared rather than removed, and
    // loadEnv maps '' to undefined — but the dialer must not depend on that mapping holding.
    const svc = new LiveKitVoiceService({ ...BASE_ENV, LIVEKIT_SIP_OUTBOUND_TRUNK_ID: '' } as any);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(svc.initiateOutboundCall('+972509788845', TENANT)).rejects.toMatchObject({
      code: 'SIP_TRUNK_NOT_CONFIGURED',
    });

    err.mockRestore();
  });

  it('still dials normally once the trunk id is present', async () => {
    // The guard must not have broken the working path. With a trunk configured the call proceeds
    // past this check — it fails later here only because no db/redis is injected, which is a
    // different code path entirely.
    const svc = new LiveKitVoiceService({
      ...BASE_ENV,
      LIVEKIT_SIP_OUTBOUND_TRUNK_ID: 'ST_8s6N3DqUVtWw',
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await svc
      .initiateOutboundCall('+972509788845', TENANT)
      .then(() => 'resolved')
      .catch((e: any) => e?.code ?? 'threw');

    expect(outcome).not.toBe('SIP_TRUNK_NOT_CONFIGURED');

    warn.mockRestore();
    err.mockRestore();
  });
});
