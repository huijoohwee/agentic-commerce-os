// Extracted from agentic-graph regionalPoiGeometry.ts; see docs/source-contract.md.
export function normalizeRegionalPoiLongitude(longitude) {
  if (!Number.isFinite(longitude)) {
    throw new RangeError('longitude must be finite')
  }
  if (longitude >= -180 && longitude < 180) {
    return Object.is(longitude, -0) ? 0 : longitude
  }
  const normalized = ((longitude + 180) % 360 + 360) % 360 - 180
  return Object.is(normalized, -0) ? 0 : normalized
}

/** Returns the shortest ordered longitude interval containing every input. */
export function deriveRegionalPoiLongitudeSpan(longitudes) {
  if (longitudes.length === 0) {
    throw new TypeError('longitude span requires at least one longitude')
  }
  const entries = [...new Set(longitudes.map(longitude => (
    normalizeRegionalPoiLongitude(longitude)
  )))].map(canonical => ({
    canonical,
    wrapped: canonical < 0 ? canonical + 360 : canonical,
  })).sort((left, right) => left.wrapped - right.wrapped)
  if (entries.length === 1) {
    const west = entries[0].canonical
    return Object.freeze({ center: west, east: west, spanDegrees: 0, west })
  }

  let largestGap = Number.NEGATIVE_INFINITY
  let west = entries[0].canonical
  let east = entries.at(-1).canonical
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index]
    const next = index === entries.length - 1
      ? { ...entries[0], wrapped: entries[0].wrapped + 360 }
      : entries[index + 1]
    if (next.wrapped - current.wrapped > largestGap) {
      largestGap = next.wrapped - current.wrapped
      west = next.canonical
      east = current.canonical
    }
  }
  if (east < west) east += 360
  const spanDegrees = east - west
  return Object.freeze({
    center: normalizeRegionalPoiLongitude(west + spanDegrees / 2),
    east,
    spanDegrees,
    west,
  })
}

export function unwrapRegionalPoiLongitude(longitude, span) {
  const normalized = normalizeRegionalPoiLongitude(longitude)
  return span.west + ((normalized - span.west) % 360 + 360) % 360
}
