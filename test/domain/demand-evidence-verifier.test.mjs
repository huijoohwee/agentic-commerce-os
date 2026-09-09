import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDemandEvidenceVerifier, paymentAttestationMessage } from '../../scripts/demand-evidence-verifier.mjs'
// Compatibility probe of the pinned owner's callback; production adapter imports no OS internals.
import { rankFeatures } from '../../node_modules/agentic-os/src/rank.mjs'
import { demandClaimDigest } from '../../node_modules/agentic-os/src/feature-grounding.mjs'
import { featureCatalogDigest } from '../../node_modules/agentic-os/src/feature-catalog.mjs'

const verifierId = 'synthetic-independent-verifier'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
const now = Date.parse('2026-09-09T12:00:00.000Z')
const capability = () => ({
  ok: true, principalsWithTwoOrMoreSettlements: 0,
  principalIdentityBasis: 'registered-agent-identifier',
  externalPrincipalDistinction: 'unvalidated', reportedAs: 'capability',
})

function fixture() {
  const candidate = {
    id: 'setup-fixture', offer: 'Synthetic merchant-independent setup',
    pain: { statement: 'Synthetic priced problem', namedProspectivePayer: 'Synthetic payer',
      evidenceRefs: ['offer.md'], demandEvidenceRefs: ['demand.json'] },
    solution: { statement: 'Existing themed storefront', evidenceRefs: ['offer.md'] },
    estimates: { codeDeltaLines: 100, firstDollarHours: 2, incrementalSpendUsd: 0, runtimeDependencies: 0 },
    requirements: { deployment: false, browserSurface: false, dependencies: [] },
  }
  const receipt = {
    schema: 'agentic-os-demand-evidence/v1', status: 'verified',
    provider: 'synthetic-payment-provider', providerReceipt: 'fixture:transfer/1',
    observedAt: '2026-09-08T12:00:00.000Z',
    candidate: { id: candidate.id, claimDigest: demandClaimDigest(candidate) },
    payer: candidate.pain.namedProspectivePayer, paidArtifact: 'fixture:accepted-deliverable/1',
    currentCost: { amount: 2, unit: 'hours' }, acceptanceCriterion: 'Synthetic merchant acceptance',
  }
  const context = {
    candidateId: candidate.id, claimDigest: receipt.candidate.claimDigest,
    evidenceDigest: `sha256:${createHash('sha256').update(JSON.stringify(receipt)).digest('hex')}`,
    evaluatedAt: new Date(now).toISOString(),
  }
  const payment = {
    receipt: 'fixture:independent-verification/1', status: 'collected', amountMinor: 100,
    currency: 'SGD', acceptanceNote: 'Synthetic accepted delivery',
  }
  payment.signature = sign(null, paymentAttestationMessage(verifierId, receipt, context, payment), privateKey)
    .toString('base64')
  return { candidate, receipt, context, payment }
}

function verifier(subject, overrides = {}) {
  return createDemandEvidenceVerifier({
    verifierId, publicKey: publicPem,
    readPaymentAttestation: () => subject.payment, readDemandEvidence: capability, ...overrides,
  })
}

test('collected external setup fee verifies with zero ledger settlements and exact OS result shape', () => {
  const subject = fixture()
  const result = verifier(subject)(subject.receipt, subject.context)
  assert.deepEqual(result, { verified: true, verifier: verifierId, receipt: subject.payment.receipt })
  assert.equal(Object.isFrozen(result), true)
})

test('capability volume cannot replace missing, unsigned, or self-signed payment evidence', () => {
  const subject = fixture()
  const other = generateKeyPairSync('ed25519')
  const selfSigned = { ...subject.payment, signature: sign(null,
    paymentAttestationMessage(verifierId, subject.receipt, subject.context, subject.payment),
    other.privateKey).toString('base64') }
  for (const payment of [null, {}, { ...subject.payment, signature: '' }, selfSigned]) {
    const run = verifier(subject, {
      readPaymentAttestation: () => payment,
      readDemandEvidence: () => ({ ...capability(), principalsWithTwoOrMoreSettlements: 10_000 }),
    })
    assert.equal(run(subject.receipt, subject.context).verified, false)
  }
})

test('every payment fact and the independent verification receipt are signed', () => {
  for (const [field, value] of Object.entries({
    receipt: 'fixture:other', amountMinor: 200, currency: 'USD', acceptanceNote: 'Changed acceptance',
    status: 'pending',
  })) {
    const subject = fixture()
    subject.payment[field] = value
    assert.equal(verifier(subject)(subject.receipt, subject.context).verified, false, field)
  }
})

test('payment signatures cannot cross candidate, payer, artifact, provider, verifier or evidence bytes', () => {
  const changes = [
    s => { s.context.evidenceDigest = `sha256:${'b'.repeat(64)}` },
    s => { s.receipt.payer = 'Another payer' },
    s => { s.receipt.paidArtifact = 'Another deliverable' },
    s => { s.receipt.provider = 'Another provider' },
    s => { s.receipt.providerReceipt = 'Another transfer' },
    s => { s.context.candidateId = s.receipt.candidate.id = 'other-candidate' },
    s => { s.context.claimDigest = s.receipt.candidate.claimDigest = `sha256:${'c'.repeat(64)}` },
  ]
  for (const change of changes) {
    const subject = fixture()
    change(subject)
    assert.equal(verifier(subject)(subject.receipt, subject.context).verified, false)
  }
  const subject = fixture()
  assert.equal(verifier(subject, { verifierId: 'other-verifier' })(subject.receipt, subject.context).verified, false)
})

test('stale, future and malformed observations refuse without invoking payment readers', () => {
  const subject = fixture()
  for (const observedAt of ['2026-07-01T00:00:00Z', '2026-09-10T00:00:00Z', 'invalid']) {
    const run = verifier(subject, { readPaymentAttestation: () => assert.fail('must fail before read') })
    assert.equal(run({ ...subject.receipt, observedAt }, subject.context).receipt, 'rejected:stale')
  }
})

test('nonpositive or inexact amounts and invalid currencies cannot construct signing bytes', () => {
  const subject = fixture()
  for (const amountMinor of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => paymentAttestationMessage(verifierId, subject.receipt, subject.context,
      { ...subject.payment, amountMinor }), /demand_payment_binding_invalid/u)
  }
  for (const currency of ['usd', '', 'US']) {
    assert.throws(() => paymentAttestationMessage(verifierId, subject.receipt, subject.context,
      { ...subject.payment, currency }), /demand_payment_binding_invalid/u)
  }
})

test('unavailable, asynchronous or relabelled demand reads cannot verify', () => {
  const subject = fixture()
  for (const demand of [null, Promise.resolve(capability()), { ...capability(), ok: false },
    { ...capability(), reportedAs: 'demand-proven' },
    { ...capability(), externalPrincipalDistinction: 'validated' },
    { ...capability(), principalsWithTwoOrMoreSettlements: -1 }]) {
    assert.equal(verifier(subject, { readDemandEvidence: () => demand })(subject.receipt, subject.context).verified, false)
  }
  for (const reader of ['readDemandEvidence', 'readPaymentAttestation']) {
    const run = verifier(subject, { [reader]: () => { throw new Error('private transport detail') } })
    const result = run(subject.receipt, subject.context)
    assert.equal(result.verified, false)
    assert.equal(JSON.stringify(result).includes('private transport detail'), false)
  }
})

test('accessors, proxies, asynchronous proofs and oversized evidence cannot enter the signing decision', () => {
  const subject = fixture()
  let calls = 0
  const accessor = { ...subject.payment, get receipt() { calls += 1; return 'mutable' } }
  const proxy = new Proxy(subject.payment, { get() { calls += 1; throw new Error('trap') } })
  for (const payment of [accessor, proxy, Promise.resolve(subject.payment),
    { ...subject.payment, acceptanceNote: 'x'.repeat(513) },
    { ...subject.payment, signature: 'A'.repeat(1_000) }]) {
    assert.equal(verifier(subject, { readPaymentAttestation: () => payment })(subject.receipt, subject.context).verified, false)
  }
  assert.equal(calls, 0)
})

test('configuration requires explicit independent trust and synchronous reader functions', () => {
  assert.throws(() => createDemandEvidenceVerifier(), /configuration_invalid/u)
  const subject = fixture()
  assert.throws(() => verifier(subject, { publicKey: '' }), /public_key_invalid/u)
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  assert.throws(() => verifier(subject, { publicKey: rsa.publicKey.export({ type: 'spki', format: 'pem' }) }), /key_type_invalid/u)
})

test('pinned OS ranker admits only signed fixture evidence; altered snapshot and age fail closed', t => {
  const subject = fixture()
  const root = mkdtempSync(join(tmpdir(), 'commerce-demand-rank-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'offer.md'), 'Synthetic behavior evidence, never a real payer.')
  const catalog = {
    schema: 'agentic-os-feature-catalog/v1',
    profile: { maxCodeDeltaLines: 200, maxFirstDollarHours: 40, maxIncrementalSpendUsd: 0,
      maxRuntimeDependencies: 0, deploymentAllowed: false, browserSurfaceAvailable: false, fossOnly: true },
    entryCount: 1, digest: '', candidates: [subject.candidate], arguments: [],
  }
  catalog.digest = featureCatalogDigest(catalog)
  writeFileSync(join(root, 'demand.json'), JSON.stringify(subject.receipt))
  const run = options => rankFeatures(catalog, {
    root, now: () => now, verifyDemandEvidence: verifier(subject), ...options,
  })
  const accepted = run()
  assert.equal(accepted.status, 'selected', JSON.stringify(accepted))
  assert.equal(accepted.selected, subject.candidate.id)
  assert.equal(accepted.trail.constraints[0].demandVerification.verifier.receipt, subject.payment.receipt)
  assert.equal(run({ verifyDemandEvidence: undefined }).status, 'no-admissible-candidate')
  assert.equal(run({ now: () => now + 31 * 24 * 60 * 60 * 1000 }).status, 'no-admissible-candidate')
  writeFileSync(join(root, 'demand.json'), JSON.stringify(subject.receipt, null, 2))
  assert.equal(run().status, 'no-admissible-candidate', 'even reformatting changes the signed evidence bytes')
})
