import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const UCHAT_API_BASE = 'https://www.uchat.com.au/api';
const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01/Accounts';

export class WhatsAppService {
  constructor(private app: FastifyInstance) {}

  async sendMessage(to: string, message: string): Promise<void> {
    if (this.app.env.TWILIO_ACCOUNT_SID) {
      return this.sendViaTwilio(to, message);
    }
    return this.sendViaUChat(to, message);
  }

  async sendVideo(to: string, url: string, caption?: string): Promise<void> {
    if (this.app.env.TWILIO_ACCOUNT_SID) {
      const body = caption ? `${caption}\n${url}` : url;
      return this.sendViaTwilio(to, body, url);
    }
    return this.sendVideoViaUChat(to, url, caption);
  }

  async sendMedia(to: string, messageType: 'text' | 'video' | 'image', options: { text?: string; url?: string; caption?: string }): Promise<void> {
    if (messageType === 'text') {
      return this.sendMessage(to, options.text!);
    }
    return this.sendVideo(to, options.url!, options.caption);
  }

  private async sendViaTwilio(to: string, body: string, mediaUrl?: string): Promise<void> {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER } = this.app.env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_NUMBER) {
      this.app.log.warn({ to }, 'Twilio WhatsApp not fully configured — skipping');
      return;
    }

    const params = new URLSearchParams({
      From: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
      To: `whatsapp:${to}`,
      Body: body,
    });
    if (mediaUrl) params.set('MediaUrl', mediaUrl);

    const credentials = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const response = await fetch(
      `${TWILIO_API_BASE}/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${credentials}`,
        },
        body: params.toString(),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      const errBody = await response.text();
      this.app.log.error({ status: response.status, body: errBody, to }, 'Twilio WhatsApp send failed');
      throw new Error(`Twilio API error: ${response.status}`);
    }

    this.app.log.info({ to }, 'WhatsApp message sent via Twilio');
  }

  private async sendViaUChat(to: string, message: string): Promise<void> {
    const token = this.app.env.UCHAT_API_TOKEN;
    if (!token) {
      this.app.log.warn({ to }, 'UCHAT_API_TOKEN not configured — skipping outbound');
      return;
    }

    const dynamicContent = {
      version: 'v1',
      content: {
        messages: [{ type: 'text', text: message }],
        actions: [],
        quick_replies: [],
      },
    };

    const subscriber = await this.findSubscriberByPhone(to);
    if (!subscriber) {
      this.app.log.warn({ to }, 'Subscriber not found in UChat — cannot send message');
      return;
    }

    const response = await fetch(`${UCHAT_API_BASE}/subscriber/send-content`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_ns: subscriber.ns, ...dynamicContent }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const body = await response.text();
      this.app.log.error({ status: response.status, body, to }, 'UChat send-content failed');
      throw new Error(`UChat API error: ${response.status}`);
    }

    this.app.log.info({ to, userNs: subscriber.ns }, 'WhatsApp message sent via UChat');
  }

  async findSubscriberByPhone(phone: string): Promise<{ ns: string; name?: string } | null> {
    const token = this.app.env.UCHAT_API_TOKEN;
    if (!token) return null;

    const params = new URLSearchParams({ phone, limit: '1' });
    const response = await fetch(`${UCHAT_API_BASE}/subscribers?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as any;
    const user = data?.data?.data?.[0];
    return user ? { ns: user.ns, name: user.name } : null;
  }

  private async sendVideoViaUChat(to: string, url: string, caption?: string): Promise<void> {
    const token = this.app.env.UCHAT_API_TOKEN;
    if (!token) {
      this.app.log.warn({ to }, 'UCHAT_API_TOKEN not configured — skipping outbound video');
      return;
    }

    const msgs: any[] = [{ type: 'video', url }];
    if (caption) msgs.push({ type: 'text', text: caption });

    const dynamicContent = {
      version: 'v1',
      content: { messages: msgs, actions: [], quick_replies: [] },
    };

    const subscriber = await this.findSubscriberByPhone(to);
    if (!subscriber) {
      this.app.log.warn({ to }, 'Subscriber not found in UChat — cannot send video');
      return;
    }

    const response = await fetch(`${UCHAT_API_BASE}/subscriber/send-content`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_ns: subscriber.ns, ...dynamicContent }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const body = await response.text();
      this.app.log.error({ status: response.status, body, to }, 'UChat send-content (video) failed');
      throw new Error(`UChat API error: ${response.status}`);
    }

    this.app.log.info({ to, userNs: subscriber.ns }, 'WhatsApp video sent via UChat');
  }

  verifyWebhookSecret(headerValue: string | undefined): boolean {
    const secret = this.app.env.UCHAT_WEBHOOK_SECRET;
    if (!secret) {
      this.app.log.warn({ event: 'whatsapp_webhook_no_secret' }, 'UCHAT_WEBHOOK_SECRET is not configured — rejecting webhook');
      return false;
    }
    if (!headerValue) return false;
    try {
      return timingSafeEqual(Buffer.from(headerValue), Buffer.from(secret));
    } catch {
      return false;
    }
  }
}
