import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { evaluateEvidenceContract } from '../../scripts/checks/evidence-contract.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
})

describe('evidence contract check', () => {
  it('validates implementation and schema invariants without running aggregate evidence', () => {
    const fixture = contractFixture()
    const marker = path.join(fixture, 'aggregate-ran')
    writePackage(fixture, {
      'check:implementation': 'npm run test:unit',
      'check:named': 'npm run test:unit',
      'check:evidence': 'node scripts/checks/evidence.ts',
      'test:unit': `node -e "require('node:fs').writeFileSync('${marker}', 'ran')"`,
    })

    expect(evaluateEvidenceContract(fixture)).toMatchObject({ ok: true, check: 'evidence-contract' })
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('rejects aggregate task checks and transitive implementation cycles', () => {
    const fixture = contractFixture('npm run check:evidence')
    writePackage(fixture, {
      'check:implementation': 'npm run check:named',
      'check:named': 'npm run check:evidence',
      'check:evidence': 'node scripts/checks/evidence.ts',
    })

    const result = evaluateEvidenceContract(fixture)
    expect(result.ok).toBe(false)
    expect(result.failures).toEqual(expect.arrayContaining([
      'implementation gate is not circular through aggregate evidence',
      'named implementation gate is not circular through aggregate evidence',
      'task checks never name an aggregate evidence gate',
    ]))
  })

  it('rejects a candidate-authored authority injection at the aggregate entrypoint', () => {
    const fixture = contractFixture()
    writePackage(fixture, {
      'check:implementation': 'npm run test:unit',
      'check:named': 'npm run test:unit',
      'check:evidence': 'node scripts/checks/evidence.ts --dispatch-trust-anchor=./candidate.json',
      'test:unit': 'node --test',
    })

    expect(evaluateEvidenceContract(fixture).failures).toContain(
      'aggregate evidence entrypoint cannot inject candidate runtime authority',
    )
  })
})

function contractFixture(namedCheck = 'npm run test:unit'): string {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-contract-'))
  temporaryDirectories.push(workspaceRoot)
  fs.mkdirSync(path.join(workspaceRoot, 'docs'))
  fs.mkdirSync(path.join(workspaceRoot, 'config'))
  fs.writeFileSync(path.join(workspaceRoot, 'docs/verification-baseline.json'), JSON.stringify({
    schema: 'agentic-commerce-verification-baseline/v1',
    implementationBaseline: 'a'.repeat(40),
    aggregateCheck: 'npm run check:implementation',
    evidenceArtifactDirectory: 'docs/evidence-verdicts',
    trustedDispatchIssuers: [],
    passingChecks: ['types:check', 'typecheck', 'test:domain', 'test:unit', 'test:workers', 'deploy:dev:dry', 'deploy:production:dry'],
  }))
  fs.writeFileSync(path.join(workspaceRoot, 'config/task-bounds.snapshot.json'), JSON.stringify({
    schema: 'agentic-commerce-task-bounds-snapshot/v2',
    source: '.kiro/specs/agentic-graph-commerce-platform/tasks.md',
    sourceSha256: 'b'.repeat(64),
    taskCount: 1,
    boundsCount: 1,
    findingCount: 0,
    namedCheckGroups: [{ namedCheck, taskIds: ['1.1'] }],
  }))
  return workspaceRoot
}

function writePackage(workspaceRoot: string, scripts: Readonly<Record<string, string>>): void {
  fs.writeFileSync(path.join(workspaceRoot, 'package.json'), JSON.stringify({ private: true, scripts }))
}
