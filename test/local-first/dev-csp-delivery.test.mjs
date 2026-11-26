import test from 'node:test';
import assert from 'node:assert/strict';
import { assertContentSecurityPolicy } from 'agentic-os/content-security-policy';
import { fetchLocalFirst } from '../../src/local-first/worker.ts';
import { LOCAL_FIRST_CSP, LOCAL_FIRST_DEV_CSP } from '../../src/local-first/content-security-policy.ts';

async function responseFor(source, origin = 'https://airvio.co') {
  return fetchLocalFirst(new Request(`${origin}/agentic-commerce-os/`), {
    RELEASE_CANDIDATE_SHA: source,
    CHECKOUT_MODE: 'sandbox',
    ASSETS: { fetch: async () => new Response('<!doctype html><html></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }) },
  });
}

test('local Dev HTML reports CSP while released HTML enforces it', async () => {
  const unreleased = await responseFor('local-unreleased');
  assertContentSecurityPolicy(unreleased.headers, { mode: 'report-only', policy: LOCAL_FIRST_DEV_CSP });

  const localHost = await responseFor('a'.repeat(40), 'http://127.0.0.1:64002');
  assertContentSecurityPolicy(localHost.headers, { mode: 'report-only', policy: LOCAL_FIRST_DEV_CSP });

  const released = await responseFor('a'.repeat(40));
  assertContentSecurityPolicy(released.headers, { mode: 'enforce', policy: LOCAL_FIRST_CSP });
});
