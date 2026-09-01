import { DurableObject } from 'cloudflare:workers'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const CURRENCY_PATTERN = /^[A-Z]{3}$/u

export type RevenueLine = Readonly<{
  settlementId: string
  agentId: string
  settledAmountMinor: number
  currency: string
  appliedRateBasisPoints: number
  markupMinor: number
  recordedAtMs: number
  recordedAt: string
}>

export class RevenueLedger extends DurableObject<CoreEnv> {
  readonly #sql: SqlStorage

  constructor(state: DurableObjectState, env: CoreEnv) {
    super(state, env)
    this.#sql = state.storage.sql
    state.blockConcurrencyWhile(async () => {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS revenue_line (
        settlement_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        settled_amount_minor INTEGER NOT NULL CHECK (settled_amount_minor >= 0),
        currency TEXT NOT NULL,
        applied_rate_basis_points INTEGER NOT NULL CHECK (applied_rate_basis_points BETWEEN 1 AND 1000),
        markup_minor INTEGER NOT NULL CHECK (markup_minor >= 0 AND markup_minor <= settled_amount_minor),
        recorded_at_ms INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
      )`)
      this.#sql.exec(`CREATE INDEX IF NOT EXISTS revenue_line_period
        ON revenue_line(recorded_at_ms, settlement_id)`)
    })
  }

  async appendLine(line: RevenueLine): Promise<unknown> {
    if (!validRevenueLine(line)) return rejected('revenue_line_malformed')
    const prior = this.#read(line.settlementId)
    if (prior) {
      return equalRevenueLine(prior, line)
        ? Object.freeze({ ok: true, idempotent: true, line: prior })
        : rejected('settlement_ledger_precondition_failed')
    }
    const result = this.#sql.exec(
      `INSERT INTO revenue_line (
        settlement_id, agent_id, settled_amount_minor, currency, applied_rate_basis_points,
        markup_minor, recorded_at_ms, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(settlement_id) DO NOTHING`,
      line.settlementId,
      line.agentId,
      line.settledAmountMinor,
      line.currency,
      line.appliedRateBasisPoints,
      line.markupMinor,
      line.recordedAtMs,
      line.recordedAt,
    )
    const stored = this.#read(line.settlementId)
    if (!stored) return rejected('revenue_line_persistence_failed')
    if (!equalRevenueLine(stored, line)) return rejected('settlement_ledger_precondition_failed')
    return Object.freeze({ ok: true, idempotent: result.rowsWritten === 0, line: stored })
  }

  async readPeriod(startInclusiveMs: number, endExclusiveMs: number): Promise<unknown> {
    if (!Number.isSafeInteger(startInclusiveMs)
      || !Number.isSafeInteger(endExclusiveMs)
      || startInclusiveMs < 0
      || endExclusiveMs <= startInclusiveMs) return rejected('revenue_period_malformed')
    const lines = this.#sql.exec<StoredRevenueLine>(
      `SELECT * FROM revenue_line WHERE recorded_at_ms >= ? AND recorded_at_ms < ?
       ORDER BY recorded_at_ms ASC, settlement_id ASC`,
      startInclusiveMs,
      endExclusiveMs,
    ).toArray().map(readRevenueLine)
    const summedMarkupMinor = lines.reduce((total, line) => total + line.markupMinor, 0)
    if (!Number.isSafeInteger(summedMarkupMinor)) return rejected('revenue_period_sum_out_of_range')
    return Object.freeze({
      ok: true,
      startInclusiveMs,
      endExclusiveMs,
      lines: Object.freeze(lines),
      summedMarkupMinor,
      lineCount: lines.length,
    })
  }

  async demandEvidence(): Promise<unknown> {
    const row = this.#sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM (
        SELECT agent_id FROM revenue_line GROUP BY agent_id HAVING COUNT(*) >= 2
      )`,
    ).one()
    return Object.freeze({
      ok: true,
      principalsWithTwoOrMoreSettlements: row?.count ?? 0,
      principalIdentityBasis: 'registered-agent-identifier',
      externalPrincipalDistinction: 'unvalidated',
      reportedAs: 'capability',
    })
  }

  #read(settlementId: string): RevenueLine | null {
    const row = this.#sql.exec<StoredRevenueLine>(
      'SELECT * FROM revenue_line WHERE settlement_id = ?',
      settlementId,
    ).toArray()[0]
    return row ? readRevenueLine(row) : null
  }
}

type StoredRevenueLine = Readonly<{
  settlement_id: string
  agent_id: string
  settled_amount_minor: number
  currency: string
  applied_rate_basis_points: number
  markup_minor: number
  recorded_at_ms: number
  recorded_at: string
}>

function readRevenueLine(row: StoredRevenueLine): RevenueLine {
  return Object.freeze({
    settlementId: row.settlement_id,
    agentId: row.agent_id,
    settledAmountMinor: row.settled_amount_minor,
    currency: row.currency,
    appliedRateBasisPoints: row.applied_rate_basis_points,
    markupMinor: row.markup_minor,
    recordedAtMs: row.recorded_at_ms,
    recordedAt: row.recorded_at,
  })
}

function validRevenueLine(line: RevenueLine): boolean {
  return Boolean(line)
    && IDENTIFIER_PATTERN.test(line.settlementId)
    && IDENTIFIER_PATTERN.test(line.agentId)
    && Number.isSafeInteger(line.settledAmountMinor)
    && line.settledAmountMinor >= 0
    && CURRENCY_PATTERN.test(line.currency)
    && Number.isSafeInteger(line.appliedRateBasisPoints)
    && line.appliedRateBasisPoints >= 1
    && line.appliedRateBasisPoints <= 1_000
    && Number.isSafeInteger(line.markupMinor)
    && line.markupMinor >= 0
    && line.markupMinor <= line.settledAmountMinor
    && Number.isSafeInteger(line.recordedAtMs)
    && line.recordedAtMs >= 0
    && new Date(line.recordedAtMs).toISOString() === line.recordedAt
}

function equalRevenueLine(left: RevenueLine, right: RevenueLine): boolean {
  return left.settlementId === right.settlementId
    && left.agentId === right.agentId
    && left.settledAmountMinor === right.settledAmountMinor
    && left.currency === right.currency
    && left.appliedRateBasisPoints === right.appliedRateBasisPoints
    && left.markupMinor === right.markupMinor
    && left.recordedAtMs === right.recordedAtMs
    && left.recordedAt === right.recordedAt
}

function rejected(code: string): Readonly<{ ok: false; code: string }> {
  return Object.freeze({ ok: false, code })
}
