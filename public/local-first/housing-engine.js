const DATE = /^\d{4}-\d{2}-\d{2}$/u
const CURRENCIES = new Set(['SGD', 'USD', 'MYR'])
const MAX_LISTINGS = 3
const PORTABLE_SCHEMA = 'commerce.housing-comparison/v1'
const PORTABLE_LIMIT = 65536
const encodedLength = value => new TextEncoder().encode(value).length
const cents = value => Number.isSafeInteger(value) && value >= 0
const dateValue = value => DATE.test(value || '') && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

export const SAMPLE_PROFILE = Object.freeze({
  start: '2027-01-05', end: '2027-05-31', budget: 1900, currency: 'SGD',
  application: 'student', credit: 'no-local-history', guarantor: 'unknown',
  transport: 'public', campus: 'North Campus', priorities: ['quiet', 'furnished'],
})

export function validateProfile(value) {
  if (!value || Object.keys(value).sort().join() !== 'application,budget,campus,credit,currency,end,guarantor,priorities,start,transport'
    || !dateValue(value.start) || !dateValue(value.end) || value.end <= value.start
    || !cents(value.budget) || value.budget < 1 || value.budget > 10000000 || !CURRENCIES.has(value.currency)
    || !['student', 'employed', 'other'].includes(value.application)
    || !['no-local-history', 'has-local-history', 'unknown'].includes(value.credit)
    || !['yes', 'no', 'unknown'].includes(value.guarantor)
    || !['public', 'walk', 'bike', 'car', 'unknown'].includes(value.transport)
    || typeof value.campus !== 'string' || value.campus.length > 60
    || !Array.isArray(value.priorities) || value.priorities.some(item => !['quiet', 'furnished', 'privacy'].includes(item))) {
    throw Error('Check the dates, budget, and selected options.')
  }
  return structuredClone(value)
}

export function validateListing(value) {
  if (!value || typeof value.id !== 'string' || !/^[a-z0-9-]{1,48}$/u.test(value.id)
    || Object.keys(value).sort().join() !== ['id','label','currency','rent','recurring','deposit','upfrontFee','leaseStart','leaseEnd','commute','commuteBasis','guarantorRequired','creditAccepted','furnished','quiet','privateRoom','sourceDate'].sort().join()
    || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 60
    || !CURRENCIES.has(value.currency) || !cents(value.rent) || value.rent < 1 || value.rent > 10000000
    || !(value.recurring === null || cents(value.recurring)) || !(value.deposit === null || cents(value.deposit))
    || !(value.upfrontFee === null || cents(value.upfrontFee))
    || !(value.leaseStart === '' || dateValue(value.leaseStart)) || !(value.leaseEnd === '' || dateValue(value.leaseEnd))
    || !(value.commute === null || Number.isSafeInteger(value.commute) && value.commute >= 0 && value.commute <= 1440)
    || !['yes', 'no', 'unknown'].includes(value.guarantorRequired)
    || !['yes', 'no', 'unknown'].includes(value.creditAccepted)
    || typeof value.commuteBasis !== 'string' || value.commuteBasis.length > 120
    || !['yes', 'no', 'unknown'].includes(value.furnished)
    || !['yes', 'no', 'unknown'].includes(value.quiet) || !['yes', 'no', 'unknown'].includes(value.privateRoom)
    || typeof value.sourceDate !== 'string' || !(value.sourceDate === '' || dateValue(value.sourceDate))) {
    throw Error('The listing has an unsupported value or is outside the allowed range.')
  }
  return structuredClone(value)
}

function monthCount(start, end) {
  if (!dateValue(start) || !dateValue(end) || end < start) return null
  const from = new Date(`${start}T00:00:00Z`), to = new Date(`${end}T00:00:00Z`)
  return Math.max(1, (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth() + (to.getUTCDate() > from.getUTCDate() ? 1 : 0))
}

export function assessListing(profileInput, listingInput) {
  const profile = validateProfile(profileInput), listing = validateListing(listingInput)
  const recurringComplete = listing.recurring !== null
  const knownMonthly = listing.rent + (listing.recurring ?? 0)
  const upfrontComplete = listing.deposit !== null && listing.upfrontFee !== null
  const moveInKnown = listing.rent + (listing.deposit ?? 0) + (listing.upfrontFee ?? 0)
  const stayMonths = monthCount(profile.start, profile.end)
  const leaseMonths = monthCount(listing.leaseStart, listing.leaseEnd)
  const mismatch = listing.currency !== profile.currency
    ? ['Currency differs from the budget. Convert separately before comparing amounts.'] : []
  if (knownMonthly > profile.budget && listing.currency === profile.currency) mismatch.push('Known monthly amount exceeds the entered budget.')
  if (listing.guarantorRequired === 'yes' && profile.guarantor === 'no') mismatch.push('A guarantor is stated as required; the profile says none is available.')
  if (listing.creditAccepted === 'no' && profile.credit === 'no-local-history') mismatch.push('The listing states local credit history is required.')
  if (profile.priorities.includes('quiet') && listing.quiet === 'no') mismatch.push('The listing is stated not to match the quiet-hours priority.')
  if (profile.priorities.includes('privacy') && listing.privateRoom === 'no') mismatch.push('The listing is stated not to have a private room, which is a selected priority.')
  if (profile.priorities.includes('furnished') && listing.furnished === 'no') mismatch.push('The listing is stated not to be furnished, which is a selected priority.')
  if (listing.leaseStart && listing.leaseStart > profile.start) mismatch.push('The lease starts after the entered arrival date.')
  const unknowns = []
  if (!recurringComplete) unknowns.push('Recurring charges are not fully stated.')
  if (!upfrontComplete) unknowns.push('Deposit or other upfront fees are unknown.')
  if (!listing.leaseStart || !listing.leaseEnd) unknowns.push('Lease dates are incomplete.')
  if (listing.guarantorRequired === 'unknown') unknowns.push('Guarantor requirements are unknown.')
  if (listing.creditAccepted === 'unknown') unknowns.push('Credit-history requirements are unknown.')
  if (profile.priorities.includes('quiet') && listing.quiet === 'unknown') unknowns.push('Quiet-hours details are unknown.')
  if (profile.priorities.includes('privacy') && listing.privateRoom === 'unknown') unknowns.push('Private-room details are unknown.')
  const overhangMonths = stayMonths !== null && leaseMonths !== null && leaseMonths > stayMonths ? leaseMonths - stayMonths : 0
  const status = mismatch.length ? 'Pause and verify' : unknowns.length ? 'More information needed' : 'No explicit mismatch found'
  return Object.freeze({
    id: listing.id, label: listing.label, currency: listing.currency, rent: listing.rent,
    recurring: listing.recurring, knownMonthly, monthlyComplete: recurringComplete,
    deposit: listing.deposit, upfrontFee: listing.upfrontFee, moveInKnown, upfrontComplete,
    leaseMonths, stayMonths, overhangMonths, overhangCost: overhangMonths * listing.rent,
    commute: listing.commute, commuteBasis: listing.commute === null ? 'Unknown' : listing.commuteBasis || 'Basis not stated',
    furnished: listing.furnished, quiet: listing.quiet, privateRoom: listing.privateRoom,
    applicationContext: profile.application, guarantorRequired: listing.guarantorRequired,
    creditAccepted: listing.creditAccepted, status, mismatch: Object.freeze(mismatch), unknowns: Object.freeze(unknowns),
  })
}

export function validateSelection(listings, ids) {
  if (!Array.isArray(listings) || !Array.isArray(ids) || ids.length < 1 || ids.length > MAX_LISTINGS
    || new Set(ids).size !== ids.length || ids.some(id => !listings.some(listing => listing.id === id))) {
    throw Error('Choose one to three available listings.')
  }
  return ids.map(id => listings.find(listing => listing.id === id))
}

export function validatePhotoBatch(existing, files) {
  const bytes = existing.reduce((n, photo) => n + photo.size, files.reduce((n, file) => n + file.size, 0))
  if (existing.length + files.length > 5 || bytes > 5242880
    || files.some(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type))) throw Error('Use up to 5 JPEG, PNG or WebP files; 5 MiB maximum.')
}

export function serializeComparison(listings, ids) {
  return JSON.stringify({ schema: PORTABLE_SCHEMA, listings: validateSelection(listings, ids).map(validateListing) })
}

export function parseComparison(value) {
  if (typeof value !== 'string' || encodedLength(value) > PORTABLE_LIMIT) throw Error('Choose a comparison JSON file under 64 KiB.')
  let data
  try { data = JSON.parse(value) } catch { throw Error('The file is not valid comparison JSON.') }
  if (!data || Object.keys(data).sort().join() !== 'listings,schema' || data.schema !== PORTABLE_SCHEMA
    || !Array.isArray(data.listings) || data.listings.length < 1 || data.listings.length > MAX_LISTINGS) {
    throw Error('The file is not a supported Housing comparison.')
  }
  const listings = data.listings.map(validateListing)
  if (new Set(listings.map(item => item.id)).size !== listings.length) throw Error('The comparison contains duplicate listing IDs.')
  return listings
}

