import type { FastifyInstance } from 'fastify';

export class EmailService {
  constructor(private app: FastifyInstance) {}

  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    // TODO: Implement Resend SDK outbound email
    this.app.log.info({ to, subject }, 'Email outbound');
  }
}
