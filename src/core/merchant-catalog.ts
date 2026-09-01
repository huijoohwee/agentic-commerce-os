export type MerchantListing = Readonly<{
  listingId: string
  owningAgentId: string
  category: string
  capabilities: readonly string[]
}>

export function projectMerchantCatalog<T extends Readonly<{ owningAgentId: string }>>(
  listings: readonly T[],
  catalogScope: readonly string[],
): readonly T[] {
  const allowed = new Set(catalogScope)
  return Object.freeze(listings.filter(({ owningAgentId }) => allowed.has(owningAgentId)))
}

export function readListing<T extends Readonly<{ listingId: string; owningAgentId: string }>>(
  listings: readonly T[],
  catalogScope: readonly string[],
  listingId: string,
): T | null {
  const allowed = new Set(catalogScope)
  return listings.find((listing) => (
    listing.listingId === listingId && allowed.has(listing.owningAgentId)
  )) ?? null
}
