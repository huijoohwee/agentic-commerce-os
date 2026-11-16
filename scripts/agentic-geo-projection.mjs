import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { generateFile } from 'agentic-os/generation';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = fileURLToPath(import.meta.resolve('agentic-geo/core'));
const output = path.join(root, 'public/local-first/agentic-geo-core.mjs');
const pinPath = path.join(root, 'config/agentic-geo-core.pin.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function installedSource() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const spec = manifest.dependencies?.['agentic-geo'];
  const match = /^github:huijoohwee\/agentic-geo#([a-f0-9]{40})$/u.exec(spec ?? '');
  const dependency = lock.packages?.['node_modules/agentic-geo'];
  if (!match || lock.packages?.[''].dependencies?.['agentic-geo'] !== spec
    || !dependency?.resolved?.endsWith('#' + match[1])) throw Error('geo_source_pin_invalid');
  const bytes = fs.readFileSync(source);
  if (bytes.length > 30000 || /\b(?:import|require|fetch|window|document|process)\b/u.test(bytes.toString('utf8'))) {
    throw Error('geo_core_closure_invalid');
  }
  return { bytes, pin: { schema: 'commerce/agentic-geo-core-projection/v1',
    owner: 'github.com/huijoohwee/agentic-geo', revision: match[1], export: 'agentic-geo/core',
    path: 'src/core.mjs', bytes: bytes.length, sha256: digest(bytes) } };
}

export function verifyGeoProjection() {
  const expected = installedSource();
  const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
  if (JSON.stringify(pin) !== JSON.stringify(expected.pin) || !fs.readFileSync(output).equals(expected.bytes)) {
    throw Error('geo_projection_drift');
  }
  return pin;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    await generateFile({ destination: output,
      receipt: path.join(root, 'node_modules/.cache/agentic-geo-projection.json'),
      maxOutputBytes: 30000, timeoutMs: 5000,
      inputs: () => installedSource().pin,
      produce: async () => installedSource().bytes });
    fs.writeFileSync(pinPath, JSON.stringify(installedSource().pin, null, 2) + '\n');
  }
  console.log(JSON.stringify(verifyGeoProjection()));
}
