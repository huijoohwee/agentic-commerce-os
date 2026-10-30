export const LOCAL_FIRST_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// Browser annotation overlays inject a shadow-root style element; allow that only in local Dev.
export const LOCAL_FIRST_DEV_CSP = `${LOCAL_FIRST_CSP}; style-src-elem 'self' 'unsafe-inline'`
