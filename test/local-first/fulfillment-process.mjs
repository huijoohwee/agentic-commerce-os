import { appendFileSync } from 'node:fs';
import { createAgentSwarmSqliteStore } from 'agentic-os/agents/sqlite-store';
import { createAgentSwarmWorker } from 'agentic-os/agents/worker';
import { AgentSwarmFailure } from 'agentic-os/agents/swarm';
import { createListingRuntime } from '../../scripts/durable-fulfillment/runtime.mjs';

const { directory, effectPath, failOnce, context } = JSON.parse(process.argv[2]);
const stateStore = await createAgentSwarmSqliteStore({ directory });
const { runtime, product } = createListingRuntime({ stateStore,
  authorize: async call => ({ allowed: call.principalId === context.principalId && context.principalExpiresAt > Date.now(),
    approvalId: 'local-product-fixture-only' }),
  executeListing: async () => {
    if (failOnce) throw new AgentSwarmFailure('fixture-interruption', { kind: 'transient', effectState: 'absent' });
    appendFileSync(effectPath, 'listing completed\n', { mode: 0o600 });
    return { status: 'completed', effect: 'read-only', output: { text: 'Ceramic mug\n- Blue\n- 300 ml', costUsd: null,
      executor: { type: 'deterministic-fixture' } } };
  },
});
const worker = createAgentSwarmWorker({ runtime, stateStore, resolveContext: async () => context });
process.on('message', async message => {
  try {
    const result = message.operation === 'tick' ? await worker.tick()
      : await product.invoke(message.operation, message.input, message.context, AbortSignal.timeout(55000));
    process.send({ id: message.id, result });
  } catch (error) { process.send({ id: message.id, error: String(error) }); }
});
process.send({ ready: true });
process.on('SIGTERM', () => { stateStore.close(); process.exit(0); });
