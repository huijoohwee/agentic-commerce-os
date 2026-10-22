export const PACK = Object.freeze({
  id: 'my.fnb.takeover', country: 'MY', asset_type: 'fnb', currency: 'MYR',
  version: '1.0.0', as_of: '2026-10-22', review_status: 'provisional', reviewer: null,
  band_basis: 'Draft interface buckets only. They are not market benchmarks and need qualified review.',
  sources: [{ id: 'SME-BUSINESS-PACK-PRD#ADR-006', kind: 'design-input', verified: false }],
  closed_band_labels: {
    seating_band: { b1: '1–10 seats', b2: '11–25 seats', b3: '26–50 seats', b4: '51–100 seats', b5: 'over 100 seats' },
    staff_band: { b1: '1–5 staff', b2: '6–10 staff', b3: '11–20 staff', b4: '21–50 staff', b5: 'over 50 staff' },
    lease_remaining_band: { b1: 'under 1 year', b2: '1–2 years', b3: '2–5 years', b4: '5–10 years', b5: 'over 10 years' },
    handover_support_band: { b1: 'none planned', b2: 'up to 1 week', b3: '1–2 weeks', b4: '2–4 weeks', b5: 'over 4 weeks' },
  },
  money_bands: {
    asking_price_band: { b1: [0, 10000], b2: [10000, 50000], b3: [50000, 150000], b4: [150000, 500000], b5: [500000, 2000000] },
    monthly_sales_band: { b1: [0, 2000], b2: [2000, 8000], b3: [8000, 25000], b4: [25000, 75000], b5: [75000, 500000] },
    monthly_rent_band: { b1: [0, 500], b2: [500, 1500], b3: [1500, 4000], b4: [4000, 10000], b5: [10000, 100000] },
  },
  money_band_labels: {
    asking_price_band: { b1: 'MYR 0 to under 10k', b2: 'MYR 10k to under 50k', b3: 'MYR 50k to under 150k', b4: 'MYR 150k to under 500k', b5: 'MYR 500k–2m' },
    monthly_sales_band: { b1: 'MYR 0 to under 2k/month', b2: 'MYR 2k to under 8k/month', b3: 'MYR 8k to under 25k/month', b4: 'MYR 25k to under 75k/month', b5: 'MYR 75k–500k/month' },
    monthly_rent_band: { b1: 'MYR 0 to under 500/month', b2: 'MYR 500 to under 1.5k/month', b3: 'MYR 1.5k to under 4k/month', b4: 'MYR 4k to under 10k/month', b5: 'MYR 10k–100k/month' },
  },
  ratios: [{ id: 'rent_to_sales', numerator: 'monthly_rent_band', denominator: 'monthly_sales_band',
    max_ratio: 1, basis: 'arithmetic-sanity-only', reviewed: false }],
  transfer_checklist: null,
})
