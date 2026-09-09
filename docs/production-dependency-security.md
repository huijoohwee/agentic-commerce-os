# Production dependency security

The release lockfile pins `qs` 6.16.0 and `sharp` 0.35.4 through root overrides.
These patched dependencies remove the reported request-parser and image-library
advisories inherited through Wrangler and the Workers test runtime. The supported
Wrangler and Workers test versions remain pinned in `package.json`.

Validate with `npm ci --ignore-scripts`, `npm audit`, the Worker tests, and the
production bundle check. Audit status is an observation of the current advisory
database; it does not replace protected integration or runtime release evidence.
