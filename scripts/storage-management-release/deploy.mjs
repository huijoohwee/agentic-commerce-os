import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG, WORKER, verifyCandidate } from './verify.mjs';
import { captureBaseline, authorizeRun, assertCurrentBaseline, readDeployments, verifyDeployment } from './provider.mjs';
import { restoreBaseline } from './rollback.mjs';

const DEFAULT_EVIDENCE = 'node_modules/.cache/storage-management-evidence';
const writeOnce = (directory, name, value) => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
};

export async function deployRelease(candidateSha, directory = DEFAULT_EVIDENCE) {
  assert.match(candidateSha, /^[a-f0-9]{40}$/u);
  const evidence = path.resolve(directory);
  const candidate = verifyCandidate({ candidateSha });
  let baseline = null, deploymentStarted = false, deployedVersion = null;
  const runId = process.env.GITHUB_RUN_ID ?? 'local';
  const message = `sm:${candidateSha.slice(0, 12)}:${runId}`;

  try {
    baseline = await captureBaseline(candidateSha, evidence);
    const authorization = await authorizeRun(candidateSha, evidence);
    const beforeWrite = await assertCurrentBaseline(evidence);
    assert.equal(beforeWrite.baseline.stateDigest, baseline.stateDigest);
    assert.deepEqual(beforeWrite.current, baseline.state, 'provider_baseline_drift');
    assert.equal(verifyCandidate({ candidateSha }).assetDigest, candidate.assetDigest,
      'candidate_changed_after_approval');

    deploymentStarted = true;
    execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy',
      '--config', CONFIG, '--message', message, '--strict'], { stdio: 'inherit', timeout: 120000 });

    deployedVersion = await readDeployments();
    assert.equal(deployedVersion.message, message, 'static_worker_candidate_message_mismatch');
    writeOnce(evidence, 'deployment-attempt.json', { schema: 'commerce.storage-management-deployment-attempt/v1',
      candidateSha, candidateDigest: candidate.assetDigest, runId, message,
      versionId: deployedVersion.versionId, observedAt: new Date().toISOString() });
    const verified = await verifyDeployment(candidateSha, evidence, message, deployedVersion.versionId);
    const receipt = { schema: 'commerce.storage-management-static-release/v1',
      candidate: verified.candidate, baseline: verified.baseline, authorization: verified.authorization,
      deploymentMessage: message, production: verified.production, readback: verified.readback,
      completedAt: new Date().toISOString() };
    writeOnce(evidence, 'release-receipt.json', receipt);
    return receipt;
  } catch (error) {
    let rollback = null;
    if (baseline && deploymentStarted) {
      try {
        deployedVersion ??= await readDeployments();
        assert.equal(deployedVersion.message, message, 'rollback_worker_is_not_this_candidate');
        rollback = await restoreBaseline({ baseline, candidateSha, message,
          expectedVersionId: deployedVersion.versionId, directory: evidence });
      } catch (rollbackError) {
        rollback = { error: rollbackError.message };
        try { writeOnce(evidence, 'rollback-failure.json', rollback); } catch { /* preserve the original release failure */ }
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`storage_management_release_failed:${detail}${rollback?.error
      ? `;rollback_failed:${rollback.error}` : ''}`, { cause: error });
  }
}

async function main() {
  const [command, candidateSha, directory = DEFAULT_EVIDENCE, ...extra] = process.argv.slice(2);
  assert.equal(command, 'deploy');
  assert(candidateSha);
  assert.equal(extra.length, 0);
  const receipt = await deployRelease(candidateSha, directory);
  process.stdout.write(`${JSON.stringify({ candidateSha, worker: WORKER,
    versionId: receipt.production.staticWorker.deployment.versionId,
    routePatterns: receipt.production.storageRoutes.map(route => route.pattern),
    assetDigest: receipt.candidate.assetDigest })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
