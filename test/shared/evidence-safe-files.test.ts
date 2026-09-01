import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listEvidenceJsonFiles,
  readExactWorkspaceFile,
  readEvidenceFile,
  resolveEvidenceArtifactRoot,
  writeEvidenceJsonAtomically,
} from '../../scripts/evidence-safe-files.ts'

const ARTIFACT_DIRECTORY = 'docs/evidence-verdicts'
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
})

describe('evidence safe files', () => {
  it('bounds exact workspace control files and refuses symlinks', () => {
    const workspaceRoot = workspace()
    const outside = temporaryDirectory('evidence-control-outside-')
    const outsideFile = path.join(outside, 'baseline.json')
    fs.writeFileSync(outsideFile, '{}\n')
    const baselinePath = path.join(workspaceRoot, 'docs/verification-baseline.json')
    fs.symlinkSync(outsideFile, baselinePath)
    expect(readExactWorkspaceFile(
      workspaceRoot, 'docs/verification-baseline.json', 'docs/verification-baseline.json', 1024,
    )).toBeNull()
    fs.rmSync(baselinePath)
    fs.writeFileSync(baselinePath, '{}\n')
    fs.truncateSync(baselinePath, 1025)
    expect(readExactWorkspaceFile(
      workspaceRoot, 'docs/verification-baseline.json', 'docs/verification-baseline.json', 1024,
    )).toBeNull()
    expect(readExactWorkspaceFile(workspaceRoot, outsideFile, 'docs/verification-baseline.json', 1024)).toBeNull()
  })

  it('requires a disjoint external artifact root and refuses symlinked roots and subdirectories', () => {
    const outsideRoot = temporaryDirectory('evidence-root-outside-')
    const rootSentinel = path.join(outsideRoot, 'sentinel.txt')
    fs.writeFileSync(rootSentinel, 'preserved\n')
    const rootWorkspace = workspace()
    const rootArtifactPath = path.join(rootWorkspace, ARTIFACT_DIRECTORY)
    fs.mkdirSync(rootArtifactPath)
    const aliasParent = temporaryDirectory('evidence-root-alias-')
    const rootAlias = path.join(aliasParent, 'artifact-root')
    fs.symlinkSync(outsideRoot, rootAlias)

    expect(resolveEvidenceArtifactRoot(rootWorkspace, ARTIFACT_DIRECTORY, rootArtifactPath)).toBeNull()
    expect(resolveEvidenceArtifactRoot(rootWorkspace, ARTIFACT_DIRECTORY, rootAlias)).toBeNull()
    expect(() => writeEvidenceJsonAtomically(
      rootWorkspace,
      rootAlias,
      path.join(rootAlias, 'checks/task.json'),
      { ok: true },
    )).toThrow('evidence_artifact_path_invalid')
    expect(fs.readFileSync(rootSentinel, 'utf8')).toBe('preserved\n')
    expect(fs.readdirSync(outsideRoot)).toEqual(['sentinel.txt'])

    const outsideChecks = temporaryDirectory('evidence-checks-outside-')
    const checksSentinel = path.join(outsideChecks, 'sentinel.txt')
    fs.writeFileSync(checksSentinel, 'preserved\n')
    const checksWorkspace = workspace()
    const checksArtifactRoot = requireArtifactRoot(checksWorkspace)
    fs.symlinkSync(outsideChecks, path.join(checksArtifactRoot, 'checks'))

    expect(() => writeEvidenceJsonAtomically(
      checksWorkspace,
      checksArtifactRoot,
      path.join(checksArtifactRoot, 'checks/task.json'),
      { ok: true },
    )).toThrow('evidence_artifact_path_invalid')
    expect(fs.readFileSync(checksSentinel, 'utf8')).toBe('preserved\n')
    expect(fs.readdirSync(outsideChecks)).toEqual(['sentinel.txt'])
  })

  it('uses exclusive unpredictable temporary files and refuses a symlinked final target', () => {
    const workspaceRoot = workspace()
    const artifactRoot = requireArtifactRoot(workspaceRoot)
    const checksDirectory = path.join(artifactRoot, 'checks')
    fs.mkdirSync(checksDirectory, { recursive: true })
    const outside = temporaryDirectory('evidence-write-outside-')
    const victim = path.join(outside, 'victim.txt')
    fs.writeFileSync(victim, 'preserved\n')
    const target = path.join(checksDirectory, 'task.json')
    fs.symlinkSync(victim, `${target}.tmp`)

    writeEvidenceJsonAtomically(workspaceRoot, artifactRoot, target, { ok: true })
    expect(fs.readFileSync(victim, 'utf8')).toBe('preserved\n')
    expect(fs.lstatSync(`${target}.tmp`).isSymbolicLink()).toBe(true)
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ ok: true })

    const linkedTarget = path.join(checksDirectory, 'linked.json')
    fs.symlinkSync(victim, linkedTarget)
    expect(() => writeEvidenceJsonAtomically(
      workspaceRoot,
      artifactRoot,
      linkedTarget,
      { ok: false },
    )).toThrow('evidence_artifact_path_invalid')
    expect(fs.readFileSync(victim, 'utf8')).toBe('preserved\n')
  })

  it('never follows a readable artifact or verdict-directory symlink', () => {
    const workspaceRoot = workspace()
    const artifactRoot = requireArtifactRoot(workspaceRoot)
    const checksDirectory = path.join(artifactRoot, 'checks')
    fs.mkdirSync(checksDirectory, { recursive: true })
    const outside = temporaryDirectory('evidence-read-outside-')
    const outsideArtifact = path.join(outside, 'artifact.json')
    fs.writeFileSync(outsideArtifact, '{}\n')
    fs.symlinkSync(outsideArtifact, path.join(checksDirectory, 'task.json'))

    expect(readEvidenceFile(
      workspaceRoot,
      artifactRoot,
      `${ARTIFACT_DIRECTORY}/checks/task.json`,
      1024,
    )).toBeNull()

    const verdictOutside = temporaryDirectory('evidence-verdict-outside-')
    const sentinel = path.join(verdictOutside, 'sentinel.json')
    fs.writeFileSync(sentinel, '{}\n')
    fs.symlinkSync(verdictOutside, path.join(artifactRoot, 'verdicts'))
    expect(listEvidenceJsonFiles(workspaceRoot, artifactRoot, 'verdicts', limits())).toBeNull()
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('{}\n')
  })

  it('bounds verdict directory entries and individual file bytes', () => {
    const entryWorkspace = workspace()
    const entryArtifactRoot = requireArtifactRoot(entryWorkspace)
    const entryDirectory = path.join(entryArtifactRoot, 'verdicts')
    fs.mkdirSync(entryDirectory, { recursive: true })
    for (let index = 0; index < 257; index += 1) {
      fs.writeFileSync(path.join(entryDirectory, `entry-${String(index).padStart(3, '0')}.json`), '{}\n')
    }
    expect(listEvidenceJsonFiles(entryWorkspace, entryArtifactRoot, 'verdicts', limits())).toBeNull()

    const byteWorkspace = workspace()
    const byteArtifactRoot = requireArtifactRoot(byteWorkspace)
    const byteDirectory = path.join(byteArtifactRoot, 'verdicts')
    fs.mkdirSync(byteDirectory, { recursive: true })
    const oversized = path.join(byteDirectory, 'oversized.json')
    fs.writeFileSync(oversized, '{')
    fs.truncateSync(oversized, 2 * 1024 * 1024 + 1)
    expect(listEvidenceJsonFiles(byteWorkspace, byteArtifactRoot, 'verdicts', limits())).toBeNull()
  })
})

function workspace(): string {
  const workspaceRoot = temporaryDirectory('evidence-safe-files-')
  fs.mkdirSync(path.join(workspaceRoot, 'docs'))
  return workspaceRoot
}

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function requireArtifactRoot(workspaceRoot: string): string {
  const externalRoot = temporaryDirectory('evidence-artifact-root-')
  const artifactRoot = resolveEvidenceArtifactRoot(workspaceRoot, ARTIFACT_DIRECTORY, externalRoot)
  if (!artifactRoot) throw new Error('fixture_artifact_root_unavailable')
  return artifactRoot
}

function limits() {
  return Object.freeze({ maximumEntries: 256, maximumFileBytes: 2 * 1024 * 1024, maximumTotalBytes: 64 * 1024 * 1024 })
}
