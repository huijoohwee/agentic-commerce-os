import { createLocalModelExecutor } from 'agentic-os/agents/local-model';
import { AgentSwarmFailure } from 'agentic-os/agents/swarm';
import { LISTING_DEFINITION, LISTING_DEFINITION_SHA256, FULFILLMENT_AGENT } from '../../src/local-first/fulfillment-definition.ts';

/** Host-only composition. The verifier must inspect current local artifact bytes
 * and the running container; caller/tool fields cannot select either artifact. */
export function createListingExecutor({ endpoint, getHeaders, verifyArtifacts, fetchImpl } = {}) {
  if (typeof getHeaders !== 'function' || typeof verifyArtifacts !== 'function')
    throw new TypeError('Listing execution requires host-owned credentials and current artifact verification.');
  const execute = createLocalModelExecutor({ endpoint, getHeaders, fetchImpl,
    modelDigest: LISTING_DEFINITION.modelSha256, imageDigest: LISTING_DEFINITION.imageDigest,
    maxTokens: LISTING_DEFINITION.maxTokens,
  });
  const refuse = code => { throw new AgentSwarmFailure(code, { kind: 'permanent', effectState: 'absent' }); };
  return async call => {
    if (call.agent?.agentId !== FULFILLMENT_AGENT.agentId || call.agent?.revision !== FULFILLMENT_AGENT.revision)
      refuse('listing_definition_mismatch');
    const draft = call.input?.task?.context;
    if (!draft || typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 120
      || typeof draft.description !== 'string' || draft.description.length > 10000)
      refuse('listing_draft_invalid');
    const observation = await verifyArtifacts({ signal: call.signal });
    if (observation?.verified !== true || observation.modelSha256 !== LISTING_DEFINITION.modelSha256
      || observation.imageDigest !== LISTING_DEFINITION.imageDigest)
      refuse('listing_artifacts_mismatch');
    const result = await execute({ ...call, input: {
      instructions: LISTING_DEFINITION.instructions,
      draft: { title: draft.title, description: draft.description },
    } });
    return { ...result, output: { ...result.output, definitionDigest: LISTING_DEFINITION_SHA256 } };
  };
}
