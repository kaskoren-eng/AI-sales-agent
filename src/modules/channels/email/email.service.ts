import { Resend } from 'resend';
import type { FastifyInstance } from 'fastify';

export class EmailService {
  private resend: Resend;
  private fromEmail: string;

  constructor(private app: FastifyInstance) {
    this.resend = new Resend(app.env.RESEND_API_KEY);
    this.fromEmail = app.env.RESEND_FROM_EMAIL ?? 'noreply@example.com';
  }

  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    if (!this.app.env.RESEND_API_KEY) {
      this.app.log.warn({ to, subject }, 'RESEND_API_KEY not configured — skipping email send');
      return;
    }

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
