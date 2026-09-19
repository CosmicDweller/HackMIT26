import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { checkReadiness } from "./services/readiness.js";

const config = loadConfig();
const app = createApp(config);

const { ready, missing } = await checkReadiness(config);
if (!ready) {
  console.warn(`Not ready: missing ${missing.join(", ")}. See server/README.md. /api/health will report "unavailable".`);
}

const server = app.listen(config.port, () => {
  console.log(`Speech-to-text server listening on http://localhost:${config.port}`);
});

// Give in-flight transcriptions a chance to finish, then exit.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), config.processTimeoutMs).unref();
  });
}
