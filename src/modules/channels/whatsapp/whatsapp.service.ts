import type { FastifyInstance } from 'fastify';

const UCHAT_API_BASE = 'https://www.uchat.com.au/api';

export class WhatsAppService {
  constructor(private app: FastifyInstance) {}

  /**
   * Send a text message to a subscriber via UChat API.
   * Uses the subscriber's user_ns (UChat internal ID) to target them.
   * Falls back to triggering a flow by phone if user_ns is unavailable.
   */
  async sendMessage(to: string, message: string): Promise<void> {
    const token = this.app.env.UCHAT_API_TOKEN;
    if (!token) {
      this.app.log.warn({ to }, 'UCHAT_API_TOKEN not configured — skipping outbound');
      return;
    }

    // UChat dynamic content format for text messages
    const dynamicContent = {
      version: 'v1',
      content: {
        messages: [{ type: 'text', text: message }],
        actions: [],
        quick_replies: [],
      },
    };

    // Look up subscriber by phone to get their user_ns
    const subscriber = await this.findSubscriberByPhone(to);
    if (!subscriber) {
      this.app.log.warn({ to }, 'Subscriber not found in UChat — cannot send message');
      return;
    }

    // Send via UChat's subscriber send-content endpoint
    const response = await fetch(`${UCHAT_API_BASE}/subscriber/send-content`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_ns: subscriber.ns,
        ...dynamicContent,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      this.app.log.error({ status: response.status, body, to }, 'UChat send-content failed');
      throw new Error(`UChat API error: ${response.status}`);
    }

    this.app.log.info({ to, userNs: subscriber.ns }, 'WhatsApp message sent via UChat');
  }

  /**
   * Find a UChat subscriber by phone number.
   */
  async findSubscriberByPhone(phone: string): Promise<{ ns: string; name?: string } | null> {
    const token = this.app.env.UCHAT_API_TOKEN;
    if (!token) return null;

    const params = new URLSearchParams({ phone, limit: '1' });
    const response = await fetch(`${UCHAT_API_BASE}/subscribers?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as any;
    const user = data?.data?.data?.[0];
    return user ? { ns: user.ns, name: user.name } : null;
  }

  /**
   * Send a video message (with optional caption) to a subscriber via UChat API.
   */
  async sendVideo(to: string, url: string, caption?: string): Promise<void> {
    const token = this.app.env.UCHAT_API_TOKEN;
    if (!token) {
      this.app.log.warn({ to }, 'UCHAT_API_TOKEN not configured — skipping outbound video');
      return;
    }

    const msgs: any[] = [{ type: 'video', url }];
    if (caption) {
      msgs.push({ type: 'text', text: caption });
    }

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
    });

    if (!response.ok) {
      const body = await response.text();
      this.app.log.error({ status: response.status, body, to }, 'UChat send-content (video) failed');
      throw new Error(`UChat API error: ${response.status}`);
    }

    this.app.log.info({ to, userNs: subscriber.ns }, 'WhatsApp video sent via UChat');
  }

  /**
   * Unified dispatcher for any message type.
   */
  async sendMedia(to: string, messageType: 'text' | 'video' | 'image', options: { text?: string; url?: string; caption?: string }): Promise<void> {
    if (messageType === 'text') {
      return this.sendMessage(to, options.text!);
    }
    return this.sendVideo(to, options.url!, options.caption);
  }

  /**
   * Verify the webhook request using a shared secret header.
   * UChat doesn't provide HMAC signing, so we use a shared secret
   * configured in both UChat's External Request action and our env.
   */
  verifyWebhookSecret(headerValue: string | undefined): boolean {
    const secret = this.app.env.UCHAT_WEBHOOK_SECRET;
    if (!secret) return true; // No secret configured = skip verification
    return headerValue === secret;
  }
}
