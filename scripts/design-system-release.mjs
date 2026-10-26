import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public/agentic-design-system');
const CONFIG = join(ROOT, 'config/design-system-static-release.json');
const PREFIX = '/agentic-design-system';
const FILES = Object.freeze([
  ['LICENSE', 'LICENSE'],
  ['site/THIRD-PARTY-NOTICES.txt', 'THIRD-PARTY-NOTICES.txt'],
  ['site/app.js', 'app.js'],
  ['site/catalog.json', 'catalog.json'],
  ['site/catalog.schema.json', 'catalog.schema.json'],
  ['site/index.html', 'index.html'],
  ['site/sw.js', 'sw.js'],
  ['site/vendor/agentic-base-browser-data-view.css', 'vendor/agentic-base-browser-data-view.css'],
  ['site/vendor/agentic-base-browser-data-view.js', 'vendor/agentic-base-browser-data-view.js'],
]);

function fail(code) { throw new Error(`design_system_release:${code}`); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function read(file) { return readFileSync(file); }
function json(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { fail('json_invalid'); }
}
function gitHead(path) {
  return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}
function digestEntries(entries) {
  return hash(Buffer.from(`${JSON.stringify(entries)}\n`, 'utf8'));
}
function pathsUnder(root) {
  if (!existsSync(root)) return [];
  const found = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail('symlink_refused');
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) found.push(relative(root, path).split(sep).join('/'));
      else fail('special_file_refused');
    }
  };
  visit(root);
  return found.sort();
}
function entriesAt(root) {
  const paths = pathsUnder(root);
  if (JSON.stringify(paths) !== JSON.stringify(FILES.map(([, target]) => target).sort())) fail('file_allowlist_mismatch');
  return paths.map((path) => {
    const bytes = read(join(root, path));
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  }).sort((a, b) => a.path.localeCompare(b.path));
}
function loadConfig() {
  const value = json(CONFIG);
  if (value.schema !== 'agentic-commerce-design-system-static-release/v1'
    || value.source?.repository !== 'github.com/huijoohwee/agentic-design-system'
    || !/^[0-9a-f]{40}$/u.test(value.source.revision ?? '')
    || !Array.isArray(value.files) || !/^[0-9a-f]{64}$/u.test(value.payloadDigest ?? '')) fail('manifest_invalid');
  return value;
}
function compareEntries(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('payload_hash_mismatch');
}
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w', mode: 0o644 });
}

function syncSource(sourceRoot, expectedRevision) {
  const source = resolve(sourceRoot);
  if (!/^[0-9a-f]{40}$/u.test(expectedRevision ?? '') || gitHead(source) !== expectedRevision) fail('source_revision_mismatch');
  const records = FILES.map(([from, to]) => {
    const path = join(source, from), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('source_file_invalid');
    return { path: to, bytes: read(path).length, sha256: hash(read(path)) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const license = read(join(source, 'LICENSE')).toString('utf8');
  if (!license.startsWith('MIT License\n')) fail('source_license_unverified');
  const current = pathsUnder(PUBLIC);
  if (current.some((path) => !FILES.some(([, target]) => target === path))) fail('destination_has_unapproved_files');
  for (const [from, to] of FILES) {
    const target = join(PUBLIC, to);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, from), target);
  }
  const payloadDigest = digestEntries(records.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })));
  const manifest = {
    schema: 'agentic-commerce-design-system-static-release/v1',
    source: { repository: 'github.com/huijoohwee/agentic-design-system', revision: expectedRevision },
    route: 'https://airvio.co/agentic-design-system/',
    files: records,
    totalBytes: records.reduce((sum, item) => sum + item.bytes, 0),
    payloadDigest,
    excluded: ['registry/', 'site/review-inventory.json', 'site/vendor/agentic-base-browser-data-view.manifest.json'],
  };
  writeJson(CONFIG, manifest);
  compareEntries(entriesAt(PUBLIC), manifest.files);
  process.stdout.write(`${JSON.stringify({ sourceRevision: expectedRevision, payloadDigest, files: records.length, totalBytes: manifest.totalBytes })}\n`);
}

function verifyDirectory(directory) {
  const config = loadConfig(), entries = entriesAt(resolve(directory));
  compareEntries(entries, config.files);
  if (digestEntries(entries) !== config.payloadDigest) fail('payload_digest_mismatch');
  return { config, entries };
}

function build(directory) {
  const output = resolve(directory);
  mkdirSync(output, { recursive: true });
  if (pathsUnder(output).length !== 0) fail('output_not_empty');
  const { config } = verifyDirectory(PUBLIC);
  for (const [, path] of FILES) {
    const target = join(output, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(PUBLIC, path), target);
  }
  const { entries } = verifyDirectory(output);
  process.stdout.write(`${JSON.stringify({ schema: 'agentic-commerce-design-system-payload/v1', sourceRevision: config.source.revision, payloadDigest: config.payloadDigest, files: entries.length, totalBytes: config.totalBytes })}\n`);
}

function identity(directory, candidateSha, preflightPath, outputPath) {
  if (!/^[0-9a-f]{40}$/u.test(candidateSha ?? '')) fail('candidate_sha_invalid');
  const { config, entries } = verifyDirectory(directory), report = json(preflightPath);
  if (report.schema !== 'agentic-os/source-control-preflight/v1' || report.ready !== true
    || report.authorizesEffects !== false || report.upstream?.expectedRevision !== report.upstream?.observedRevision
    || report.consumer?.revision !== candidateSha || report.consumer?.canonical?.remoteRevision !== candidateSha) fail('source_control_preflight_not_ready');
  const preflightDigest = hash(read(preflightPath));
  const value = {
    schema: 'agentic-commerce-design-system-candidate/v1',
    candidateRevision: candidateSha,
    sourceRevision: config.source.revision,
    sourceControlPreflightDigest: preflightDigest,
    payloadDigest: config.payloadDigest,
    files: entries,
    totalBytes: config.totalBytes,
  };
  writeJson(outputPath, value);
  process.stdout.write(`${JSON.stringify({ candidateRevision: candidateSha, sourceRevision: config.source.revision, sourceControlPreflightDigest: preflightDigest, payloadDigest: config.payloadDigest, totalBytes: config.totalBytes })}\n`);
}

async function fetchBounded(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1_000_000) fail('readback_body_too_large');
  return { response, bytes };
}

async function readback(base, directory, candidateSha, outputPath) {
  if (!/^[0-9a-f]{40}$/u.test(candidateSha ?? '')) fail('candidate_sha_invalid');
  const { config, entries } = verifyDirectory(directory), origin = new URL(base);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) fail('readback_origin_invalid');
  const proof = [];
  const urlFor = (path, query = '') => `${origin.origin}${PREFIX}/${path}${query}`;
  const redirectUrl = urlFor('', '?route-check=slashless');
  const { response: redirect } = await fetchBounded(redirectUrl, { redirect: 'manual' });
  const expectedLocation = `${origin.origin}${PREFIX}/?route-check=slashless`;
  if (redirect.status !== 308 || redirect.headers.get('location') !== expectedLocation) fail('slashless_redirect_mismatch');
  proof.push({ path: `${PREFIX}?route-check=slashless`, status: redirect.status, location: expectedLocation });
  for (const item of entries) {
    const { response, bytes } = await fetchBounded(urlFor(item.path));
    if (response.status !== 200 || hash(bytes) !== item.sha256) fail(`asset_readback_mismatch:${item.path}`);
    if (response.headers.get('x-design-system-source') !== config.source.revision
      || response.headers.get('x-design-system-release') !== candidateSha
      || response.headers.get('x-design-system-payload') !== config.payloadDigest) fail(`asset_provenance_mismatch:${item.path}`);
    proof.push({ path: `${PREFIX}/${item.path}`, status: response.status, sha256: hash(bytes), bytes: bytes.length });
  }
  const head = await fetchBounded(urlFor('index.html'), { method: 'HEAD' });
  if (head.response.status !== 200 || head.bytes.length !== 0) fail('head_readback_mismatch');
  for (const path of ['registry/owner-ledger.json', 'review-inventory.json', 'vendor/agentic-base-browser-data-view.manifest.json']) {
    const { response } = await fetchBounded(urlFor(path));
    if (response.status !== 404) fail(`excluded_file_exposed:${path}`);
    proof.push({ path: `${PREFIX}/${path}`, status: 404 });
  }
  writeJson(outputPath, {
    schema: 'agentic-commerce-design-system-runtime-readback/v1',
    origin: origin.origin,
    candidateRevision: candidateSha,
    sourceRevision: config.source.revision,
    payloadDigest: config.payloadDigest,
    checkedAt: new Date().toISOString(),
    proof,
  });
  process.stdout.write(`${JSON.stringify({ origin: origin.origin, candidateRevision: candidateSha, sourceRevision: config.source.revision, payloadDigest: config.payloadDigest, checks: proof.length })}\n`);
}

function parsePagesDeployment(path, branch, candidateSha) {
  const parsed = json(path), rows = Array.isArray(parsed) ? parsed : parsed.result ?? parsed.deployments;
  if (!Array.isArray(rows)) fail('pages_deployments_schema_invalid');
  const shaOf = (row) => row.commit_hash ?? row.commitHash ?? row.source?.commit_hash
    ?? row.deployment_trigger?.metadata?.commit_hash ?? row.deployment_trigger?.metadata?.commitHash
    ?? row.Source ?? (typeof row.source === 'string' ? row.source : undefined);
  const branchOf = (row) => row.branch ?? row.Branch ?? row.source?.branch ?? row.deployment_trigger?.metadata?.branch;
  const commitMatches = (value) => {
    if (value === candidateSha) return true;
    if (typeof value !== 'string' || !/^[0-9a-f]{7,39}$/u.test(value) || !candidateSha.startsWith(value)) return false;
    try {
      const resolved = execFileSync('git', ['-C', ROOT, 'rev-parse', '--verify', `${value}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return resolved === candidateSha;
    } catch { return false; }
  };
  const matches = rows.filter((row) => commitMatches(shaOf(row)) && branchOf(row) === branch);
  if (matches.length !== 1) fail('pages_candidate_deployment_not_unique');
  const row = matches[0], id = row.id ?? row.deployment_id ?? row.Id;
  if (typeof id !== 'string' || !id) fail('pages_deployment_id_missing');
  process.stdout.write(`${JSON.stringify({ id, url: row.url ?? row.Deployment ?? row.aliases?.[0] ?? null, branch, commitSha: candidateSha, environment: row.environment ?? row.Environment?.toLowerCase() ?? (branch === 'main' ? 'production' : 'preview') })}\n`);
}

function parseWorkerDeployment(path, expectedName) {
  const parsed = json(path), rows = Array.isArray(parsed) ? parsed : parsed.deployments ?? parsed.result;
  if (!Array.isArray(rows) || rows.length === 0) fail('worker_deployment_schema_invalid');
  const latest = rows[0];
  const name = latest.script_name ?? latest.scriptName ?? latest.name;
  if (name && name !== expectedName) fail('worker_deployment_name_mismatch');
  const versions = latest.versions ?? [];
  const version = versions.find((item) => item.percentage === 100 || item.percentage === 1) ?? versions[0];
  const versionId = latest.version_id ?? latest.versionId ?? version?.version_id ?? version?.id;
  if (typeof versionId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(versionId)) fail('worker_version_id_missing');
  process.stdout.write(`${JSON.stringify({ script: expectedName, versionId, deploymentId: latest.id ?? latest.deployment_id ?? null, createdAt: latest.created_on ?? latest.createdAt ?? null })}\n`);
}

async function routeStatus(expectedScript, requireActive) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) fail('cloudflare_token_missing');
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const api = async (url) => {
    const response = await fetchBounded(url, { headers });
    if (!response.response.ok) fail('cloudflare_readback_http_error');
    const body = JSON.parse(response.bytes.toString('utf8'));
    if (body.success !== true) fail('cloudflare_readback_api_error');
    return body.result;
  };
  const zones = await api('https://api.cloudflare.com/client/v4/zones?name=airvio.co');
  if (!Array.isArray(zones) || zones.length !== 1 || zones[0].name !== 'airvio.co') fail('zone_identity_mismatch');
  const routes = await api(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zones[0].id)}/workers/routes`);
  if (!Array.isArray(routes)) fail('route_list_invalid');
  const matches = routes.filter((route) => route.pattern === 'airvio.co/agentic-design-system*');
  if (matches.length === 0 && !requireActive) {
    process.stdout.write(`${JSON.stringify({ schema: 'agentic-commerce-design-system-route-baseline/v1', zone: 'airvio.co', pattern: 'airvio.co/agentic-design-system*', state: 'absent' })}\n`);
    return;
  }
  if (matches.length !== 1 || matches[0].script !== expectedScript || matches[0].request_limit_fail_open !== false) fail('route_fail_closed_unverified');
  const proof = { schema: requireActive ? 'agentic-commerce-design-system-route-proof/v1' : 'agentic-commerce-design-system-route-baseline/v1', zone: 'airvio.co', pattern: matches[0].pattern, script: matches[0].script, routeId: matches[0].id, requestLimitFailOpen: false, state: 'active' };
  process.stdout.write(`${JSON.stringify(proof)}\n`);
}

function workerUrl(path) {
  const text = readFileSync(path, 'utf8');
  const matches = [...text.matchAll(/https:\/\/[a-z0-9.-]+\.workers\.dev(?:\/[a-z0-9/_-]*)?/giu)].map((match) => match[0]);
  const unique = [...new Set(matches)];
  if (unique.length !== 1) fail('worker_dev_url_not_unique');
  const value = new URL(unique[0]);
  if (!value.hostname.endsWith('.workers.dev') || value.pathname !== '/') fail('worker_dev_url_invalid');
  process.stdout.write(`${value.origin}\n`);
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'sync-source' && rest.length === 2) return syncSource(rest[0], rest[1]);
  if (command === 'build' && rest.length === 1) return build(rest[0]);
  if (command === 'verify' && rest.length === 1) {
    const { config, entries } = verifyDirectory(rest[0]);
    process.stdout.write(`${JSON.stringify({ payloadDigest: config.payloadDigest, sourceRevision: config.source.revision, files: entries.length, totalBytes: config.totalBytes })}\n`);
    return;
  }
  if (command === 'identity' && rest.length === 4) return identity(...rest);
  if (command === 'readback' && rest.length === 4) return readback(...rest);
  if (command === 'pages-deployment' && rest.length === 3) return parsePagesDeployment(...rest);
  if (command === 'worker-deployment' && rest.length === 2) return parseWorkerDeployment(...rest);
  if (command === 'route-baseline' && rest.length === 1) return routeStatus(rest[0], false);
  if (command === 'route-proof' && rest.length === 1) return routeStatus(rest[0], true);
  if (command === 'worker-url' && rest.length === 1) return workerUrl(rest[0]);
  fail('usage');
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error && error.message.startsWith('design_system_release:') ? error.message : 'design_system_release:failed'}\n`);
  process.exitCode = 1;
});
