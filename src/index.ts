import { buildApp } from './server.js';

/**
 * How long to let in-flight work finish before exiting anyway. Railway sends SIGTERM and then
 * SIGKILLs after ~30s, so this must stay comfortably under that or the forced kill wins and the
 * drain was pointless.
 */
const SHUTDOWN_TIMEOUT_MS = 20_000;

async function main() {
  const app = await buildApp();

  // WHY THIS BLOCK EXISTS: every onClose hook in the codebase — the six BullMQ workers, the seven
  // queues, the PG pool, the Redis connection, and the Sentry flush — only runs when app.close()
  // is called. Nothing called it in production. Railway sends SIGTERM on every redeploy, the
  // process died immediately, and so jobs were killed mid-execution instead of drained and
  // buffered Sentry events were lost. All that careful cleanup was dead code outside of tests.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    // A second Ctrl-C, or a SIGTERM racing a SIGINT, must not start a second close().
    if (shuttingDown) {
      app.log.warn({ signal }, 'shutdown already in progress, ignoring');
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, 'shutdown started — draining');

    // Belt and braces: if a worker hangs on a stuck job, exit anyway rather than wait for SIGKILL.
    // unref() so this timer alone cannot hold the event loop open on a clean, fast shutdown.
    const forceExit = setTimeout(() => {
      app.log.error({ signal, timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      await app.close();
      app.log.info({ signal }, 'shutdown complete');
      process.exit(0);
    } catch (err) {
      app.log.error({ err, signal }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Without these the process dies silently on an unhandled rejection, skipping the Sentry flush —
  // i.e. the errors most worth seeing are exactly the ones that never get reported.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled rejection');
    app.sentry?.captureException(reason);
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'uncaught exception — shutting down');
    app.sentry?.captureException(err);
    void shutdown('uncaughtException');
  });

  try {
    await app.listen({ port: app.env.PORT, host: app.env.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
