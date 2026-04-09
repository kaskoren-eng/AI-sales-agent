import type { FastifyInstance } from 'fastify';

export class VoiceService {
  constructor(private app: FastifyInstance) {}

  async handleIncomingCall(callSid: string, from: string): Promise<string> {
    // TODO: Implement Twilio + ElevenLabs agent orchestration
    // Return TwiML response
    this.app.log.info({ callSid, from }, 'Voice incoming call');
    return '<Response><Say>Thank you for calling. Our AI agent will be with you shortly.</Say></Response>';
  }

  /**
   * Initiate an outbound call to a lead via Twilio.
   * The call connects to our voice webhook which hands off to ElevenLabs.
   */
  async initiateOutboundCall(to: string, tenantId: string): Promise<string> {
    const accountSid = this.app.env.TWILIO_ACCOUNT_SID;
    const authToken = this.app.env.TWILIO_AUTH_TOKEN;
    const fromNumber = this.app.env.TWILIO_PHONE_NUMBER;
    const baseUrl = this.app.env.BASE_URL;

    if (!accountSid || !authToken || !fromNumber) {
      this.app.log.warn({ to }, 'Twilio not configured — skipping outbound call');
      return 'skipped';
    }

    // TODO: Replace with actual Twilio client call
    // import twilio from 'twilio';
    // const client = twilio(accountSid, authToken);
    // const call = await client.calls.create({
    //   to,
    //   from: fromNumber,
    //   url: `${baseUrl}/webhooks/voice/outbound?tenantId=${tenantId}`,
    // });
    // return call.sid;

    this.app.log.info({ to, tenantId }, 'Outbound call initiated (stub)');
    return 'stub-call-sid';
  }
}
