import { createCloudflareWorker } from "agentic-os/agents/cloudflare-worker";
import { createCommerceWorkerExtension } from "./worker-extension.js";
export { createWorkerFetch } from "agentic-os/agents/cloudflare-worker";
export { CanvasRoom } from "agentic-os/agents/canvas-room";
export { AgentState } from "./agent-state.js";
const worker = createCloudflareWorker({ createExtension: createCommerceWorkerExtension });
export const handleCloudflareRequest = worker.fetch;
export default worker;
// Retain the existing same-Worker authenticated release-proof entrypoint.
export const CommerceAdmissionProbe = Object.freeze({ fetch: worker.fetch });
