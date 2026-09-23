// Type boundary for the installed agentic-os/invocation JavaScript export.
// The runtime implementation and digest byte contract stay upstream-owned.
declare module "agentic-os/invocation" {
  export function serializeInvocationCatalogForDigest(entries: readonly unknown[]): string;
  export function serializeInvocationRoutingForDigest(
    entries: readonly unknown[],
    schema: string,
  ): string;
}
