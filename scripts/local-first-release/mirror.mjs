import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_MIRROR_MANIFEST, CONTENT_MIRROR_REPOSITORY, CONTENT_MIRROR_SCHEMA,
  FILES, PRIVATE_FILES, assertCleanCandidate, digest, git, readLocalFirstAsset,
  sourceManifest, verifyCommerceContentMirror } from './artifact.mjs';

const allowedFiles = [...FILES, ...PRIVATE_FILES].sort();

export function createCommerceContentMirror(sourceRevision, outputRoot) {
  assertCleanCandidate(sourceRevision);
  if (git('ls-remote', 'origin', 'refs/heads/main') !== `${sourceRevision}\trefs/heads/main`)
    throw Error('Commerce mirror source must be the exact protected main revision');
  sourceManifest(sourceRevision, { checkout: 'sandbox' });
  const target = path.resolve(outputRoot);
  if (fs.existsSync(target) || fs.lstatSync(path.dirname(target)).isSymbolicLink())
    throw Error('Commerce mirror output must be a new path in a regular parent directory');
  const parent = path.dirname(target), stage = fs.mkdtempSync(path.join(parent, '.commerce-content-mirror-'));
  try {
    let totalBytes = 0;
    const files = allowedFiles.map(file => {
      const bytes = readLocalFirstAsset(file);
      if (bytes.length >= 500000) throw Error(`Commerce mirror file exceeds its byte budget: ${file}`);
      totalBytes += bytes.length;
      fs.writeFileSync(path.join(stage, file), bytes, { flag: 'wx' });
      return { path: file, bytes: bytes.length, sha256: digest(bytes) };
    });
    if (totalBytes > 3000000) throw Error('Commerce mirror exceeds its total byte budget');
    const body = { schema: CONTENT_MIRROR_SCHEMA, repository: 'github.com/huijoohwee/agentic-commerce-os',
      sourceRevision, sourceTree: git('rev-parse', `${sourceRevision}^{tree}`), files, totalBytes };
    fs.writeFileSync(path.join(stage, CONTENT_MIRROR_MANIFEST),
      JSON.stringify({ ...body, manifestDigest: digest(JSON.stringify(body)) }, null, 2) + '\n', { flag: 'wx' });
    verifyCommerceContentMirror(stage, { sourceRevision, sourceTree: body.sourceTree });
    fs.renameSync(stage, target);
    return verifyCommerceContentMirror(target, { sourceRevision, sourceTree: body.sourceTree });
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== 'create' || !process.env.CANDIDATE_SHA || !process.argv[3])
      throw Error('Usage: CANDIDATE_SHA=<exact-main-sha> node scripts/local-first-release/mirror.mjs create <new-output-path>');
    console.log(JSON.stringify({ ok: true, ...createCommerceContentMirror(process.env.CANDIDATE_SHA, process.argv[3]) }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
