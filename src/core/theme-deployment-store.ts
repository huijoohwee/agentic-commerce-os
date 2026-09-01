import { DurableObject } from 'cloudflare:workers'

import { canonicalJson } from '../shared/digest.js'
import type { ThemeManifest } from '../shared/theme-manifest.js'
import {
  authoringMutationRequestDigest,
  merchantThemeClaim,
  type ClaimMutationPermit,
} from '../domain/authoring-claim-policy.js'
import { runAuthoringFencedMutation } from './authoring-mutation-fence.js'

export type ActivatedTheme = Readonly<{
  merchantId: string
  manifestDigest: string
  manifest: ThemeManifest
  resolvedCatalogScope: readonly string[]
  defaultedFields: readonly string[]
  deployedAtMs: number
  deployedAt: string
}>

export function themeActivationMutationIntent(record: ActivatedTheme): unknown {
  return Object.freeze({
    merchantId: record.merchantId,
    manifestDigest: record.manifestDigest,
    manifest: record.manifest,
    resolvedCatalogScope: record.resolvedCatalogScope,
    defaultedFields: record.defaultedFields,
  })
}

export class ThemeDeployment extends DurableObject<CoreEnv> {
  readonly #sql: SqlStorage

  constructor(state: DurableObjectState, env: CoreEnv) {
    super(state, env)
    this.#sql = state.storage.sql
    state.blockConcurrencyWhile(async () => {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS theme_deployment (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        merchant_id TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        record_json TEXT NOT NULL,
        deployed_at_ms INTEGER NOT NULL,
        deployed_at TEXT NOT NULL
      )`)
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS authoring_mutation_fence (
        semantic_scope TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL,
        fence_revision TEXT NOT NULL,
        mutation_id TEXT NOT NULL,
        mutation_sequence INTEGER NOT NULL,
        request_digest TEXT NOT NULL,
        lease_expires_at_ms INTEGER NOT NULL
      )`)
      const fenceColumns = this.#sql.exec<{ name: string }>('PRAGMA table_info(authoring_mutation_fence)').toArray()
      if (!fenceColumns.some(({ name }) => name === 'mutation_sequence')) {
        this.#sql.exec('ALTER TABLE authoring_mutation_fence ADD COLUMN mutation_sequence INTEGER NOT NULL DEFAULT 0')
      }
      if (!fenceColumns.some(({ name }) => name === 'request_digest')) {
        this.#sql.exec("ALTER TABLE authoring_mutation_fence ADD COLUMN request_digest TEXT NOT NULL DEFAULT ''")
      }
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS authoring_mutation_outcome (
        mutation_id TEXT PRIMARY KEY,
        semantic_scope TEXT NOT NULL,
        mutation_sequence INTEGER NOT NULL,
        permit_json TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        outcome_json TEXT NOT NULL
      )`)
    })
  }

  async activate(record: ActivatedTheme, permit: ClaimMutationPermit): Promise<unknown> {
    if (!validActivatedTheme(record)) return rejected('theme_activation_malformed')
    const requestDigest = await authoringMutationRequestDigest(
      merchantThemeClaim(record.merchantId),
      themeActivationMutationIntent(record),
    )
    const fenced = runAuthoringFencedMutation(
      this.ctx.storage,
      this.#sql,
      permit,
      merchantThemeClaim(record.merchantId),
      requestDigest,
      () => {
        const prior = this.#read()
        if (prior?.manifestDigest === record.manifestDigest) {
          return Object.freeze({ ok: true, idempotent: true, record: prior })
        }
        this.#sql.exec(
          `INSERT INTO theme_deployment (
            singleton, merchant_id, manifest_digest, record_json, deployed_at_ms, deployed_at
          ) VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            merchant_id = excluded.merchant_id,
            manifest_digest = excluded.manifest_digest,
            record_json = excluded.record_json,
            deployed_at_ms = excluded.deployed_at_ms,
            deployed_at = excluded.deployed_at`,
          record.merchantId,
          record.manifestDigest,
          canonicalJson(record),
          record.deployedAtMs,
          record.deployedAt,
        )
        return Object.freeze({ ok: true, idempotent: false, record })
      },
    )
    return fenced.ok ? fenced.value : fenced
  }

  async current(): Promise<Readonly<{ ok: true; record: ActivatedTheme | null }>> {
    return Object.freeze({ ok: true, record: this.#read() })
  }

  #read(): ActivatedTheme | null {
    const row = this.#sql.exec<{ record_json: string }>(
      'SELECT record_json FROM theme_deployment WHERE singleton = 1',
    ).toArray()[0]
    return row ? JSON.parse(row.record_json) as ActivatedTheme : null
  }
}

function validActivatedTheme(record: ActivatedTheme): boolean {
  return Boolean(record)
    && typeof record.merchantId === 'string'
    && record.merchantId.length > 0
    && /^[0-9a-f]{64}$/u.test(record.manifestDigest)
    && Array.isArray(record.resolvedCatalogScope)
    && Array.isArray(record.defaultedFields)
    && Number.isSafeInteger(record.deployedAtMs)
    && new Date(record.deployedAtMs).toISOString() === record.deployedAt
}

function rejected(code: string): Readonly<{ ok: false; code: string }> {
  return Object.freeze({ ok: false, code })
}
