import { createAgentToolkitRuntime } from 'agentic-os/agents/toolkit';
import { createAgentResourceAdmission, createAgentToolkitAdmissionController } from 'agentic-os/agents/toolkit-admission';
import { AgentToolkitBlock, normalizeRunContext, AGENT_TOOLKIT_DEFAULTS } from 'agentic-os/agents/toolkit-contract';
import { digestToolkitEvidence, runRecordId, toolkitSubjectDigest } from 'agentic-os/agents/toolkit-ledger';
import { validateRunInput } from 'agentic-os/agents/invocation';
import { FULFILLMENT_AGENT, FULFILLMENT_GOAL, validRunId } from '../../src/local-first/fulfillment-contract.ts';
import { LISTING_DEFINITION_SHA256 } from '../../src/local-first/fulfillment-definition.ts';

const HOST_PRINCIPAL = 'listing-host-budget/v1', HOST_PROJECT = 'listing-host';
const DAY = 86400000;
const hostRun = (principalId, runId) => digestToolkitEvidence([principalId, runId]);
const roles = ['prd', 'tad', 'adr', 'mvp', 'gtm'];
export const LISTING_LOCAL_COST = Object.freeze({ model: 'listing-contract', prompt_tokens: 0,
  completion_tokens: 0, cache_hits: 0, estimated_cost_usd: 0 });
const ref = (id, value) => ({ id, revision: 'v1', digest: digestToolkitEvidence(value) });
const profile = Object.freeze({ dataset: ref('listing-definition', LISTING_DEFINITION_SHA256),
  evaluator: ref('listing-contract-completeness', ['run:completed-definition-nonempty-output', 'span:completed-measured-duration']),
  metric: { ...ref('contract-completeness', ['binary', 'contract-v1']), direction: 'maximize' } });
const fail = code => { throw new AgentToolkitBlock(code, code); };
const equal = (a, b) => digestToolkitEvidence(a) === digestToolkitEvidence(b);

/** Host-owned references and limits; the browser cannot select a plan or allocation. */
export function createListingMission({ stateStore, toolkitStore, authorize, plan, now = Date.now }) {
  if (!stateStore || !toolkitStore || typeof authorize !== 'function') fail('listing_mission_unconfigured');
  const trusted = normalizeRunContext({ projectId: 'listing-workspace', goalId: 'reviewed-listing', taskId: 'validation', plan }).plan;
  if (trusted.repository !== 'github.com/huijoohwee/agentic-commerce-os'
    || trusted.path !== 'docs/durable-fulfillment.md' || trusted.continuityId !== 'DURABLE-LISTING-FULFILLMENT-001'
    || roles.some(role => trusted.revisions[role] !== '0.3.0') || /^0+$/.test(trusted.revision)) fail('listing_plan_invalid');

  function contextFor(value) {
    const { signal, ...input } = value;
    const request = validateRunInput('start', input), draft = request.input;
    if (!validRunId(request.runId) || !equal(request.agent, FULFILLMENT_AGENT)
      || request.goal !== FULFILLMENT_GOAL || request.maxParallel !== 1
      || !draft || Object.keys(draft).sort().join() !== 'description,draftId,revision,title'
      || typeof draft.draftId !== 'string' || !/^[a-f0-9-]{36}$/.test(draft.draftId)
      || request.conversationId !== draft.draftId || !Number.isSafeInteger(draft.revision) || draft.revision < 1
      || typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 120
      || typeof draft.description !== 'string' || draft.description.length > 10000) fail('listing_context_invalid');
    const context = normalizeRunContext({ projectId: 'listing-workspace', goalId: 'reviewed-listing',
      taskId: request.runId, plan: trusted,
      receipt: { id: 'draft/' + draft.draftId + '/' + draft.revision, digest: digestToolkitEvidence(draft) } });
    if (request.context !== undefined && !equal(request.context, context)) fail('listing_context_mismatch');
    return context;
  }
  async function resolveContext(context, { principalId, phase }) {
    if (!['observe', 'plan', 'work', 'synthesize', 'evaluate'].includes(phase)) fail('listing_phase_unknown');
    const record = await stateStore.get(context.taskId);
    if (!record || record.ownerPrincipalId !== principalId) fail('run_forbidden');
    const source = record.request ?? record;
    const expected = contextFor({ runId: source.runId, conversationId: source.conversationId,
      agent: source.agent, goal: source.goal, input: source.input, maxParallel: source.maxParallel });
    if (!equal(context, expected)) fail('context_stale');
    const startsAt = Math.floor(now() / 86400000) * 86400000;
    const project = { inputTokens: 65536, outputTokens: 8192, attempts: 96, elapsedMs: 1800000 };
    return { context: expected, allocation: { id: 'listing-session', revision: 'v1',
      windowId: new Date(startsAt).toISOString().slice(0, 10), startsAt, endsAt: startsAt + 86400000,
      project, agent: project, run: { inputTokens: 4096, outputTokens: 512, attempts: 8, elapsedMs: 112000 },
      bounds: phase === 'work' ? { inputTokens: 2048, outputTokens: 256, attempts: 1, elapsedMs: 55000 }
        : { inputTokens: 0, outputTokens: 0, attempts: 1, elapsedMs: 1000 }, providerCostMicros: 0 } };
  }
  const callerResources = createAgentResourceAdmission({ stateStore: toolkitStore, resolveContext, now });
  const hostAdmission = createAgentToolkitAdmissionController({ stateStore: toolkitStore, now,
    limits: { ...AGENT_TOOLKIT_DEFAULTS, maxPrincipalRuns: 12, runTtlMs: 8 * DAY } });
  const hostResources = createAgentResourceAdmission({ stateStore: toolkitStore, now,
    resolveContext: async (context, { principalId, phase }) => {
      if (principalId !== HOST_PRINCIPAL || context.projectId !== HOST_PROJECT) fail('allocation_forbidden');
      const job = await stateStore.get(context.taskId);
      const resolved = await resolveContext({ ...context, projectId: 'listing-workspace' },
        { principalId: job?.ownerPrincipalId, phase });
      return { context: { ...resolved.context, projectId: HOST_PROJECT },
        allocation: { ...resolved.allocation, id: 'listing-host' } };
    } });
  const pairs = new WeakMap();
  const resources = Object.freeze({ ...callerResources,
    async reserve(request) {
      await callerResources.resolve(request.context, request.principalId, request.phase);
      const host = await hostResources.reserve({ ...request, principalId: HOST_PRINCIPAL,
        runId: hostRun(request.principalId, request.runId), context: { ...request.context, projectId: HOST_PROJECT } });
      let caller;
      try { caller = await callerResources.reserve(request); }
      catch (error) {
        // This attempt did not dispatch. A replay may already represent unknown usage.
        if (!host.replay) await hostResources.settle(host, HOST_PRINCIPAL,
          { inputTokens: 0, outputTokens: 0, attempts: 0, elapsedMs: 0 }).catch(() => {});
        throw error;
      }
      if (caller.replay !== host.replay) fail('allocation_usage_unknown');
      const reservation = Object.freeze({ ...caller });
      pairs.set(reservation, { caller, host, principalId: request.principalId });
      return reservation;
    },
    async settle(reservation, principalId, usage) {
      const pair = pairs.get(reservation);
      if (!pair || pair.principalId !== principalId) fail('allocation_forbidden');
      const caller = await callerResources.settle(pair.caller, principalId, usage);
      const host = await hostResources.settle(pair.host, HOST_PRINCIPAL, usage);
      if (caller.state !== host.state) fail('allocation_usage_unknown');
      // Keep the pair so an exact retry can finish a partially failed settlement.
      return caller;
    },
  });
  const toolkit = createAgentToolkitRuntime({ stateStore: toolkitStore, resources, now, runTtlMs: 7 * 86400000,
    authorize: async call => {
      const verdict = await authorize(call);
      return { allowed: verdict?.allowed === true, authorizationId: verdict?.approvalId,
        ...(verdict?.reasonCode ? { reasonCode: verdict.reasonCode } : {}) };
    },
    evaluate: async ({ subject, profile: requestedProfile }) => {
      const trace = await toolkitStore.get(runRecordId(subject.principalId, subject.runId));
      const job = await stateStore.get(subject.runId);
      if (!trace || !job || trace.ownerPrincipalId !== subject.principalId || job.ownerPrincipalId !== subject.principalId
        || !equal(requestedProfile, profile) || !equal(trace.profile, profile)
        || toolkitSubjectDigest(trace, subject.spanId) !== subject.digest) fail('listing_evaluation_subject_invalid');
      const target = subject.spanId ? trace.spans.find(span => span.spanId === subject.spanId) : trace.completion;
      const output = job.synthesis?.output;
      const valid = target?.status === 'completed' && (subject.spanId ? Number.isFinite(target.durationMs)
        : job.status === 'completed' && output?.definitionDigest === LISTING_DEFINITION_SHA256
          && typeof output.text === 'string' && output.text.trim().length > 0);
      return { status: 'reported', score: valid ? 1 : 0, metric: profile.metric,
        evidence: { id: 'contract/' + subject.digest, digest: digestToolkitEvidence({ subject, valid,
          definitionDigest: output?.definitionDigest ?? null, status: target?.status ?? null }) },
        costLog: LISTING_LOCAL_COST };
    },
  });
  return Object.freeze({ options: { toolkit, resources, traceProfile: profile, requireContext: true },
    async admit({ principalId, runId }) {
      const result = await hostAdmission.admit({ action: 'start', principalId: HOST_PRINCIPAL,
        runId: hostRun(principalId, runId), cohortId: 'listing-host' });
      if (!result.allowed) fail(result.reasonCode);
    },
    bind(value) { return { ...value, context: contextFor(value) }; } });
}
