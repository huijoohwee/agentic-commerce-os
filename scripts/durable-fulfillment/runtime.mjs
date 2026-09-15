import { createAgentSwarmRuntime, AgentSwarmFailure } from 'agentic-os/agents/swarm';
import { dispatchRunOperation } from 'agentic-os/agents/invocation';
import { FULFILLMENT_AGENT } from '../../src/local-first/fulfillment-contract.ts';

/** Product composition only. The host supplies persistent storage, a pinned local
 * executor and current authorization. No model, timer or process starts on import. */
export function createListingRuntime({ stateStore, executeListing, authorize, now = Date.now } = {}) {
  if (!stateStore || typeof executeListing !== 'function' || typeof authorize !== 'function')
    throw new TypeError('Listing runtime needs explicit storage, execution and authority.');
  const runtime = createAgentSwarmRuntime({ stateStore, now,
    maxTasks: 1, maxParallel: 1, maxWaves: 1, maxAttempts: 2,
    taskEffect: 'read-only', planningEffect: 'read-only',
    taskTimeoutMs: 55_000, taskLeaseMs: 90_000, runTtlMs: 86400000, retentionMs: 7 * 86400000,
    retryBaseMs: 2000, retryMaxMs: 30000,
    authorize: async call => {
      if (call.agent?.agentId !== FULFILLMENT_AGENT.agentId || call.agent?.revision !== FULFILLMENT_AGENT.revision)
        return { allowed: false, reasonCode: 'listing_definition_mismatch' };
      return authorize(call);
    },
    resolveAgent: async ({ agent }) => {
      if (agent.agentId !== FULFILLMENT_AGENT.agentId || agent.revision !== FULFILLMENT_AGENT.revision)
        throw Error('listing_definition_mismatch');
      return { status: 'ready', ...FULFILLMENT_AGENT };
    },
    planTasks: async call => ({ status: 'completed', planId: FULFILLMENT_AGENT.revision, tasks: [{
      taskId: 'listing', objective: call.goal, dependencies: [], context: call.input,
    }] }),
    executeTask: async call => {
      const result = await executeListing(call);
      if (result?.status !== 'completed' || result.effect !== 'read-only')
        throw new AgentSwarmFailure('listing_output_invalid', { kind: 'permanent', effectState: 'unknown' });
      return result;
    },
    synthesize: async ({ tasks }) => {
      if (tasks.length !== 1 || tasks[0].taskId !== 'listing' || tasks[0].status !== 'completed')
        throw new AgentSwarmFailure('listing_incomplete', { kind: 'permanent', effectState: 'absent' });
      return { status: 'completed', output: tasks[0].output };
    },
    verifyReceipt: async () => ({ verified: false }),
  });
  return Object.freeze({ runtime, product: Object.freeze({
    async invoke(operation, input, context, signal) {
      try { return await dispatchRunOperation(runtime, operation, input, context, signal); }
      catch (error) {
        if (['run_forbidden', 'principal_expired'].includes(error.reasonCode))
          return { runId: input.runId, status: 'blocked', reasonCode: error.reasonCode };
        throw error;
      }
    },
  }) });
}
