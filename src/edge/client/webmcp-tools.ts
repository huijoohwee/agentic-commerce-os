import { canonicalJson, sha256Hex } from '../../shared/digest'
import { isRecord } from '../../shared/http'
import { recordChange } from './local-store'
import type { StorefrontActions } from './storefront-actions'

export const MAXIMUM_REGISTERED_TOOLS = 16
export const WEBMCP_REGISTRATION_LIMIT_MS = 2_000

type JsonSchema = Readonly<Record<string, unknown>>

export type RegisteredTool = Readonly<{
  name: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
}>

export type RegisteredToolSet = Readonly<{
  tools: readonly RegisteredTool[]
  toolCount: number
  digest: string
}>

export type RegistrationOutcome =
  | Readonly<{ ok: true; registered: RegisteredToolSet; registeredInMs: number }>
  | Readonly<{ ok: false; code: 'model_context_api_absent'; event: 'webmcp_surface_unavailable' }>
  | Readonly<{ ok: false; code: 'webmcp_registration_timeout'; registeredInMs: number }>
  | Readonly<{ ok: false; code: 'webmcp_registration_failed'; reason: string }>

export type ToolRefusal = Readonly<{
  ok: false
  code: 'webmcp_registration_drift'
  invokedTool: string
  recordedDigest: string
  observedDigest: string
}>

type ModelContextTool = Readonly<{
  name: string
  title: string
  description: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  annotations: Readonly<{ readOnlyHint: boolean; untrustedContentHint: boolean }>
  execute(input: Readonly<Record<string, unknown>>, options: Readonly<{ signal: AbortSignal }>): Promise<unknown>
}>

export type ModelContextLike = Readonly<{
  registerTool(
    tool: Omit<ModelContextTool, 'outputSchema'>,
    options?: Readonly<{ signal: AbortSignal }>,
  ): Promise<undefined | void>
  getTools(options?: Readonly<{ fromOrigins?: readonly string[] }>): Promise<readonly Readonly<{
    name: string
    inputSchema?: unknown
  }>[]>
}>

export type WebMcpRegistrationOptions = Readonly<{
  modelContext?: ModelContextLike | null
  now?: () => number
  definitions?: readonly ModelContextTool[]
  recordEvidence?: (event: Readonly<Record<string, unknown>>) => Promise<void>
}>

export async function registerStorefrontTools(
  actions: StorefrontActions,
  options: WebMcpRegistrationOptions = {},
): Promise<RegistrationOutcome> {
  const modelContext = options.modelContext === undefined ? browserModelContext() : options.modelContext
  const recordEvidence = options.recordEvidence ?? recordWebMcpEvidence
  if (!modelContext) {
    await recordEvidence(Object.freeze({
      schema: 'agentic-graph-evidence-event/v1',
      type: 'webmcp_surface_unavailable',
      absentApi: 'document.modelContext',
      recordedAt: new Date().toISOString(),
    }))
    return Object.freeze({
      ok: false,
      code: 'model_context_api_absent',
      event: 'webmcp_surface_unavailable',
    })
  }

  const now = options.now ?? performanceNow
  const definitions = options.definitions ?? storefrontToolDefinitions(actions)
  if (definitions.length < 3 || definitions.length > MAXIMUM_REGISTERED_TOOLS) {
    return Object.freeze({ ok: false, code: 'webmcp_registration_failed', reason: 'tool_count_out_of_bounds' })
  }
  const registered = await buildRegisteredToolSet(definitions)
  const startedAt = now()
  const registrationController = new AbortController()
  const guarded = definitions.map((definition) => Object.freeze({
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: definition.annotations,
    execute: async (input: Readonly<Record<string, unknown>>, execution: Readonly<{ signal: AbortSignal }>) => {
      const observed = await observedNativeToolSet(modelContext, definitions)
      const refusal = await verifyBeforeExecute(registered, definition.name, observed)
      if (refusal) {
        registrationController.abort(new Error('webmcp_registration_drift'))
        await recordEvidence(Object.freeze({
          schema: 'agentic-graph-evidence-event/v1',
          type: 'webmcp_registration_drift',
          invokedTool: definition.name,
          recordedDigest: refusal.recordedDigest,
          observedDigest: refusal.observedDigest,
          recordedAt: new Date().toISOString(),
        }))
        return refusal
      }
      if (execution.signal.aborted) throw execution.signal.reason
      return definition.execute(input, execution)
    },
  }))

  try {
    const live = await withinRegistrationDeadline(
      Promise.all(guarded.map((definition) => modelContext.registerTool(
        definition,
        { signal: registrationController.signal },
      ))).then(() => modelContext.getTools()),
    )
    const observed = await projectNativeToolSet(live, definitions)
    if (await verifyBeforeExecute(registered, 'registration', observed)) {
      registrationController.abort(new Error('webmcp_registration_drift'))
      return Object.freeze({
        ok: false,
        code: 'webmcp_registration_failed',
        reason: 'webmcp_registration_drift',
      })
    }
  } catch (error) {
    registrationController.abort(error)
    const registeredInMs = Math.max(0, now() - startedAt)
    if (error instanceof Error && error.message === 'webmcp_registration_timeout') {
      return Object.freeze({ ok: false, code: 'webmcp_registration_timeout', registeredInMs })
    }
    return Object.freeze({
      ok: false,
      code: 'webmcp_registration_failed',
      reason: error instanceof Error ? error.name : 'unknown_error',
    })
  }
  const registeredInMs = Math.max(0, now() - startedAt)
  if (registeredInMs > WEBMCP_REGISTRATION_LIMIT_MS) {
    registrationController.abort(new Error('webmcp_registration_timeout'))
    return Object.freeze({ ok: false, code: 'webmcp_registration_timeout', registeredInMs })
  }
  return Object.freeze({ ok: true, registered, registeredInMs })
}

export async function buildRegisteredToolSet(
  definitions: readonly Pick<ModelContextTool, 'name' | 'inputSchema' | 'outputSchema'>[],
): Promise<RegisteredToolSet> {
  const tools = Object.freeze(definitions.map((definition) => Object.freeze({
    name: definition.name,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
  })).sort((left, right) => left.name.localeCompare(right.name)))
  const toolCount = tools.length
  const digest = await sha256Hex(canonicalJson({ tools, toolCount }))
  return Object.freeze({ tools, toolCount, digest })
}

export async function verifyBeforeExecute(
  recorded: RegisteredToolSet,
  invokedTool: string,
  observed: RegisteredToolSet = recorded,
): Promise<ToolRefusal | null> {
  return recorded.digest === observed.digest
    ? null
    : Object.freeze({
      ok: false,
      code: 'webmcp_registration_drift',
      invokedTool,
      recordedDigest: recorded.digest,
      observedDigest: observed.digest,
    })
}

export async function observedNativeToolSet(
  modelContext: ModelContextLike,
  definitions: readonly Pick<ModelContextTool, 'name' | 'outputSchema'>[],
): Promise<RegisteredToolSet> {
  return projectNativeToolSet(await modelContext.getTools(), definitions)
}

async function projectNativeToolSet(
  live: readonly Readonly<{ name: string; inputSchema?: unknown }>[],
  definitions: readonly Pick<ModelContextTool, 'name' | 'outputSchema'>[],
): Promise<RegisteredToolSet> {
  const expectedOutputSchemas = new Map(definitions.map(({ name, outputSchema }) => [name, outputSchema]))
  return buildRegisteredToolSet(live.map((tool) => ({
    name: tool.name,
    inputSchema: isRecord(tool.inputSchema)
      ? tool.inputSchema
      : Object.freeze({ invalidNativeInputSchema: true }),
    outputSchema: expectedOutputSchemas.get(tool.name)
      ?? Object.freeze({ unknownNativeTool: true }),
  })))
}

export function storefrontToolDefinitions(actions: StorefrontActions): readonly ModelContextTool[] {
  return Object.freeze([
    Object.freeze({
      name: 'commerce.catalog.search',
      title: 'Search storefront catalog',
      description: 'Search the current storefront catalog with a bounded shopper query.',
      inputSchema: objectSchema({
        query: { type: 'string', maxLength: 280 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      }, ['query', 'limit']),
      outputSchema: objectSchema({
        ok: { const: true },
        query: { type: 'string' },
        limit: { type: 'integer' },
        listings: { type: 'array' },
      }, ['ok', 'query', 'limit', 'listings']),
      annotations: Object.freeze({ readOnlyHint: true, untrustedContentHint: true }),
      async execute(input: Readonly<Record<string, unknown>>) {
        assertExactKeys(input, ['query', 'limit'])
        return actions.searchCatalog({ query: readText(input.query), limit: readInteger(input.limit) })
      },
    }),
    Object.freeze({
      name: 'commerce.offer.select',
      title: 'Select one storefront offer',
      description: 'Select one offer previously returned by the current storefront catalog.',
      inputSchema: objectSchema({
        listingId: { type: 'string', minLength: 1, maxLength: 128 },
        offerId: { type: 'string', minLength: 1, maxLength: 128 },
      }, ['listingId', 'offerId']),
      outputSchema: objectSchema({
        ok: { type: 'boolean' },
        listingId: { type: 'string' },
        offerId: { type: 'string' },
        amountMinor: { type: 'integer' },
        currency: { type: 'string' },
        code: { type: 'string' },
        retained: { type: 'integer' },
      }, ['ok']),
      annotations: Object.freeze({ readOnlyHint: false, untrustedContentHint: true }),
      async execute(input: Readonly<Record<string, unknown>>) {
        assertExactKeys(input, ['listingId', 'offerId'])
        return actions.selectOffer({ listingId: readText(input.listingId), offerId: readText(input.offerId) })
      },
    }),
    Object.freeze({
      name: 'commerce.checkout.initiate',
      title: 'Initiate a guarded checkout',
      description: 'Prepare the selected offer for a separate human-confirmation step; this tool cannot settle.',
      inputSchema: objectSchema({
        offerId: { type: 'string', minLength: 1, maxLength: 128 },
        amountMinor: { type: 'integer', minimum: 1 },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      }, ['offerId', 'amountMinor', 'currency']),
      outputSchema: objectSchema({
        ok: { type: 'boolean' },
        checkoutId: { type: 'string' },
        state: { const: 'awaiting-human-confirmation' },
        code: { type: 'string' },
      }, ['ok']),
      annotations: Object.freeze({ readOnlyHint: false, untrustedContentHint: true }),
      async execute(input: Readonly<Record<string, unknown>>) {
        assertExactKeys(input, ['offerId', 'amountMinor', 'currency'])
        return actions.initiateCheckout({
          offerId: readText(input.offerId),
          amountMinor: readInteger(input.amountMinor),
          currency: readText(input.currency),
        })
      },
    }),
  ])
}

function browserModelContext(): ModelContextLike | null {
  const documentValue = Reflect.get(globalThis, 'document')
  if (!documentValue || typeof documentValue !== 'object') return null
  const modelContext = Reflect.get(documentValue, 'modelContext')
  return modelContext
    && typeof modelContext === 'object'
    && typeof Reflect.get(modelContext, 'registerTool') === 'function'
    && typeof Reflect.get(modelContext, 'getTools') === 'function'
    ? modelContext as ModelContextLike
    : null
}

async function recordWebMcpEvidence(event: Readonly<Record<string, unknown>>): Promise<void> {
  const outcome = await recordChange(Object.freeze({
    scope: 'webmcp-evidence',
    payload: event,
    recordedAtMs: Date.now(),
  }))
  if (!outcome.ok) console.warn(JSON.stringify({ event: 'webmcp_evidence_capacity_reached' }))
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): JsonSchema {
  return Object.freeze({
    type: 'object',
    properties: Object.freeze(properties),
    required: Object.freeze([...required]),
    additionalProperties: false,
  })
}

function assertExactKeys(input: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  if (!isRecord(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new Error('webmcp_input_invalid')
  }
}

function readText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('webmcp_input_invalid')
  return value
}

function readInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error('webmcp_input_invalid')
  return Number(value)
}

function performanceNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

async function withinRegistrationDeadline<T>(registrations: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      registrations,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('webmcp_registration_timeout')),
          WEBMCP_REGISTRATION_LIMIT_MS,
        )
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
