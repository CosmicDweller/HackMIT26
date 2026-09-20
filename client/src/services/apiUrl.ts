/**
 * Where the backend lives.
 *
 * In development the Vite dev server proxies `/api` to localhost:3001 (see vite.config.ts), so a relative path is correct and
 * VITE_API_BASE_URL is left unset. A production build has no such proxy: the bundle is served by a static host that knows nothing
 * about `/api`, so unless the host rewrites those paths itself the origin of the API has to be baked in at build time.
 *
 * Set VITE_API_BASE_URL to the backend's origin (no trailing slash) when the two are deployed separately, e.g.
 *   VITE_API_BASE_URL=https://scribe-api.example.com
 * Leave it empty to keep paths relative, which is what you want when the host proxies /api to the backend for you.
 */
const BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

export function apiUrl(path: string): string {
  return BASE ? `${BASE}${path}` : path;
}
