export const PACK = Object.freeze({
  id: 'sg.fnb.takeover', country: 'SG', asset_type: 'fnb', currency: 'SGD',
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
    asking_price_band: { b1: [0, 50000], b2: [50000, 150000], b3: [150000, 300000], b4: [300000, 800000], b5: [800000, 2000000] },
    monthly_sales_band: { b1: [0, 5000], b2: [5000, 15000], b3: [15000, 40000], b4: [40000, 100000], b5: [100000, 500000] },
    monthly_rent_band: { b1: [0, 1000], b2: [1000, 3000], b3: [3000, 8000], b4: [8000, 20000], b5: [20000, 100000] },
  },
  money_band_labels: {
    asking_price_band: { b1: 'SGD 0 to under 50k', b2: 'SGD 50k to under 150k', b3: 'SGD 150k to under 300k', b4: 'SGD 300k to under 800k', b5: 'SGD 800k–2m' },
    monthly_sales_band: { b1: 'SGD 0 to under 5k/month', b2: 'SGD 5k to under 15k/month', b3: 'SGD 15k to under 40k/month', b4: 'SGD 40k to under 100k/month', b5: 'SGD 100k–500k/month' },
    monthly_rent_band: { b1: 'SGD 0 to under 1k/month', b2: 'SGD 1k to under 3k/month', b3: 'SGD 3k to under 8k/month', b4: 'SGD 8k to under 20k/month', b5: 'SGD 20k–100k/month' },
  },
  ratios: [{ id: 'rent_to_sales', numerator: 'monthly_rent_band', denominator: 'monthly_sales_band',
    max_ratio: 1, basis: 'arithmetic-sanity-only', reviewed: false }],
  transfer_checklist: null,
})
