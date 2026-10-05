# Production dependency security

The release lockfile pins `qs` 6.16.0 and `sharp` 0.35.4 through root overrides.
These patched dependencies remove the reported request-parser and image-library
advisories inherited through Wrangler and the Workers test runtime. The supported
Wrangler and Workers test versions remain pinned in `package.json`.

The 2026-10-05 runtime-readiness correction also locks compatible `fast-uri` 3.1.8,
`hono` 4.13.13 and `ip-address` 10.7.3. A clean installation followed by
`npm audit --omit=dev --json` reported zero production advisories for that lockfile.
No new dependency, override or always-loaded module is introduced. These are
source corrections until the exact lockfile reaches its protected runtime release.

Validate with `npm ci --ignore-scripts`, `npm audit`, the Worker tests, and the
production bundle check. Audit status is an observation of the current advisory
database; it does not replace protected integration or runtime release evidence.
