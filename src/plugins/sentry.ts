import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

/**
 * Sentry error monitoring plugin.
 *
 * Initializes Sentry when SENTRY_DSN is set. Captures:
 *   - Unhandled exceptions and promise rejections (via Sentry SDK defaults)
 *   - HTTP 5xx errors from Fastify's error handler
 *   - BullMQ worker failures (wired in each worker's failed handler)
 *
 * When SENTRY_DSN is not set the plugin is a no-op — safe for local dev.
 */

async function sentryPlugin(app: FastifyInstance) {
  const dsn = app.env.SENTRY_DSN;
  if (!dsn) {
    app.log.info('Sentry DSN not set — error monitoring disabled');
    return;
  }

  const Sentry = await import('@sentry/node');

  Sentry.init({
    dsn,
    environment: app.env.SENTRY_ENVIRONMENT ?? app.env.NODE_ENV,
    tracesSampleRate: app.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    // Don't send PII
    sendDefaultPii: false,
  });

  // Decorate app so workers can access the Sentry client
  app.decorate('sentry', Sentry);

  // Hook into Fastify's error lifecycle to capture 5xx errors
  app.addHook('onError', async (_request, _reply, error) => {
    // Only capture server-side errors; 4xx are expected client mistakes
    const status = (error as any).statusCode ?? 500;
    if (status >= 500) {
      Sentry.captureException(error);
    }
  });

  // Flush pending events before the process shuts down
  app.addHook('onClose', async () => {
    await Sentry.close(2000);
  });

  app.log.info({ environment: app.env.SENTRY_ENVIRONMENT ?? app.env.NODE_ENV }, 'Sentry initialized');
}

export default fp(sentryPlugin, { name: 'sentry' });
