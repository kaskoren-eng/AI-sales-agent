import { buildApp } from './server.js';

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: app.env.PORT, host: app.env.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
