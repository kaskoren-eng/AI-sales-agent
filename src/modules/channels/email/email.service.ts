import { Resend } from 'resend';
import type { FastifyInstance } from 'fastify';

/**
 * THE RESEND CLIENT IS BUILT ON FIRST SEND, NOT IN THE CONSTRUCTOR.
 *
 * `RESEND_API_KEY` is `.optional()` in env.ts — the API is supposed to run without a mailer — but
 * `new Resend(undefined)` throws "Missing API key" from inside the vendor's own constructor. This
 * service is constructed while `authRoutes` and `membersRoutes` register, so that throw happened
 * during plugin registration: an environment with no mail key did not boot the API at all, and the
 * operator's first signal was a third-party stack trace rather than our own configuration error.
 * Standing up staging, restoring for DR, or a new developer's first `npm run dev` all hit it, and
 * the message named nothing you could act on.
 *
 * Lazy construction keeps the promise env.ts already makes: the key is optional, mail degrades,
 * the API boots. Callers that need to know whether mail can actually leave the building ask
 * `configured` and pick their own fallback — see the invite route, which hands the operator the
 * raw token instead of pretending a mail was sent.
 */
export class EmailService {
  private resend: Resend | null = null;
  private fromEmail: string;

  /**
   * Whether a send can actually be delivered. Anything with a fallback path — an invite, a reset
   * link — must check this rather than discovering it from a log line nobody is reading.
   */
  readonly configured: boolean;

  constructor(private app: FastifyInstance) {
    this.fromEmail = app.env.RESEND_FROM_EMAIL ?? 'noreply@example.com';
    this.configured = Boolean(app.env.RESEND_API_KEY);
  }

  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    const apiKey = this.app.env.RESEND_API_KEY;
    if (!apiKey) {
      this.app.log.warn({ to, subject }, 'RESEND_API_KEY not configured — skipping email send');
      return;
    }

    this.resend ??= new Resend(apiKey);

    const { error } = await this.resend.emails.send({
      from: this.fromEmail,
      to,
      subject,
      html,
    });

    if (error) {
      throw new Error(`Resend error: ${error.message}`);
    }
  }
}
