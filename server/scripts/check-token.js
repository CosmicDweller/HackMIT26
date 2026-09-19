// Verify a real Supabase access token against the configured project, without printing it.
//   In the app's browser console:  (await supabase.auth.getSession()).data.session.access_token
//   Then:                          pbpaste | npm run check-token
// Reads the token from stdin (so it stays out of your shell history) and prints only the verified
// identity, never the token. Uses exactly the verification the API uses.
import { loadConfig } from "../config.js";
import { supabaseKeys, verifyAccessToken } from "../middleware/auth.js";

const config = loadConfig();
if (!config.supabaseUrl) {
  console.error("SUPABASE_URL is not set (server/.env).");
  process.exit(2);
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
const token = input.trim().replace(/^Bearer\s+/i, "");
if (!token) {
  console.error("Paste the access token on stdin, e.g. `pbpaste | npm run check-token`.");
  process.exit(2);
}

try {
  const user = await verifyAccessToken(token, supabaseKeys(config.supabaseUrl));
  console.log("Token is valid.");
  console.log(`  doctor id : ${user.id}`);
  console.log(`  email     : ${user.email ?? "(none)"}`);
  console.log(`  expires   : ${user.expiresAt}`);
  console.log("  credentials verified: no (self-registered accounts are not verified clinicians)");
} catch (error) {
  console.error(`Token rejected: ${error.code ?? "ERROR"} - ${error.message}`);
  process.exit(1);
}
