import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const pin = JSON.parse(fs.readFileSync(path.join(root, 'config/workspace-pack-graph.json'), 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
function validatePin() {
  assert.equal(pin.schema, 'commerce.workspace-pack-graph/v1');
  assert.equal(pin.repository, 'huijoohwee/agentic-graph');
  assert.match(pin.revision, /^[a-f0-9]{40}$/);
  assert.equal(pin.entry, 'canvas/src/features/block-editor/workspaceProgramPack.ts');
  assert.equal(pin.artifact.path, 'src/generated/graph-workspace-pack.js');
  assert(pin.artifact.bytes > 0 && pin.artifact.bytes < 500000);
  assert.match(pin.artifact.sha256, /^[a-f0-9]{64}$/);
  assert(pin.inputs.length > 0 && pin.inputs.length <= 16);
  assert.equal(new Set(pin.inputs.map(input => input.path)).size, pin.inputs.length);
  for (const input of pin.inputs) {
    assert(/^canvas\/src\/features\/[A-Za-z0-9_./-]+\.ts$/.test(input.path) && !input.path.includes('..'));
    assert(input.bytes > 0 && input.bytes < 100000);
    assert.match(input.sha256, /^[a-f0-9]{64}$/);
  }
}
function readRegular(file, maximum) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.size <= maximum, 'Graph input must be a bounded regular file');
    const bytes = fs.readFileSync(fd);
    assert(bytes.length <= maximum);
    return bytes;
  } finally { fs.closeSync(fd); }
}
export function verifyGraphBundle() {
  validatePin();
  const bytes = readRegular(path.join(root, pin.artifact.path), 499999);
  assert(bytes.length === pin.artifact.bytes && sha(bytes) === pin.artifact.sha256, 'Pinned Graph bundle mismatch');
  return pin;
}
export async function rebuildGraphBundle(sourceRoot) {
  validatePin();
  assert(path.isAbsolute(sourceRoot), 'Use the absolute path of the pinned Graph checkout');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', timeout: 5000 }).trim(), pin.revision);
  const require = createRequire(import.meta.url), esbuild = createRequire(require.resolve('wrangler/package.json'))('esbuild');
  assert.equal(esbuild.version, pin.esbuild, 'Rebuild requires the pinned esbuild version');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-graph-pack-'));
  try {
    for (const input of pin.inputs) {
      const bytes = readRegular(path.join(sourceRoot, input.path), input.bytes);
      assert(bytes.length === input.bytes && sha(bytes) === input.sha256, 'Pinned Graph source mismatch: ' + input.path);
      const file = path.join(temp, input.path);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' });
    }
    const result = await esbuild.build({ absWorkingDir: temp, entryPoints: [pin.entry], bundle: true,
      format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, metafile: true,
      alias: { '@': path.join(temp, 'canvas/src') } });
    assert.deepEqual(Object.keys(result.metafile.inputs).sort(), pin.inputs.map(input => input.path).sort());
    const output = `// Generated from agentic-graph ${pin.revision}; regenerate with scripts/workspace-pack/build-graph.mjs.\n` + result.outputFiles[0].text;
    assert(Buffer.byteLength(output) === pin.artifact.bytes && sha(output) === pin.artifact.sha256, 'Graph rebuild differs from reviewed artifact');
    // Reproduction checks immutable bytes; updating a pin requires a separately reviewed candidate.
    assert.deepEqual(Buffer.from(output), readRegular(path.join(root, pin.artifact.path), 499999));
    return { ok: true, revision: pin.revision, bytes: pin.artifact.bytes, sha256: pin.artifact.sha256 };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--check') {
    verifyGraphBundle(); console.log(JSON.stringify({ ok: true, revision: pin.revision, artifact: pin.artifact }));
  } else if (args.length === 2 && args[0] === '--source-root') console.log(JSON.stringify(await rebuildGraphBundle(args[1])));
  else throw Error('Expected --check or --source-root <pinned Graph checkout>');
}
