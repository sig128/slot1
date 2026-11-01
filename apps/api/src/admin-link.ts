import { createRedis, loadConfig, sanitizeErrorMessage } from "@slot1/platform";
import { mintAdminLink } from "./lib/admin-session";

/**
 * Prints a one-time sign-in link for the admin dashboard (docs/ADMIN.md). Run it where the API
 * runs, with the same environment: `node dist/admin-link.js` in the api container (the server's
 * `slot1 admin-link` does exactly that). The link is the last line of the output.
 */
const config = loadConfig();
const redis = createRedis(config.env.REDIS_URL);
try {
  const { url, expiresAt } = await mintAdminLink({ config, redis });
  process.stdout.write(`One-time admin link. It works once, until ${expiresAt} (UTC). Don't share it.\n${url}\n`);
} catch (err) {
  console.error(`Couldn't create an admin link: ${sanitizeErrorMessage((err as Error).message)}`);
  process.exitCode = 1;
} finally {
  await redis.quit().catch(() => undefined);
}
