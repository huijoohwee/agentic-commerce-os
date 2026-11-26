import { LAUNCH_MONEY_FIELDS, MAXIMUM_AMOUNT_MINOR, invalidLaunchFields, isArchived } from './drafts.js';
import { formatMoney, moneyDigits, parseMoney } from './launch.js';
import { compareOfferDrivers, DEFAULT_BAND_PERCENT } from './offer-simulator.js';
import { createKeyTypeValueRow, createFieldTypeIcon } from './key-type-value.js';
import { createNativeDashboard } from './dashboard.js';

const labels = {
  priceMinor: 'Price', deliveryCostMinor: 'Delivery cost per sale', providerFeeMinor: 'Provider fee per sale',
  agentCostMinor: 'Agent cost per sale', acquisitionCostMinor: 'Acquisition cost per sale', fixedCostMinor: 'One-time setup cost',
  variableCostMinor: 'Total cost per sale', contributionMinor: 'Contribution per sale', firstSaleNetMinor: 'Net after one sale',
  tenSalesNetMinor: 'Net after ten sales', breakEvenSales: 'Sales to break even', bandPercent: 'Sensitivity band (%)',
  merchantId: 'merchant ID', agentId: 'agent ID', audience: 'audience', outcome: 'outcome', currency: 'currency',
};
function element(tag, text) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(label, click) {
  const control = element('button', label);
  control.type = 'button'; control.addEventListener('click', click);
  return control;
}
function row(field, control, ...others) {
  const label = element('label', labels[field]), group = element('div');
  control.id = 'sim-' + field; label.htmlFor = control.id; group.append(control, ...others);
  return createKeyTypeValueRow({ keyNode: label, typeNode: createFieldTypeIcon('number'), valueNode: group });
}

export function createOfferSimulator(host, adopt) {
  const { DashboardCardGrid } = createNativeDashboard(document);
  const status = element('p'), result = element('section'), inputs = element('section');
  status.setAttribute('role', 'status');
  const band = element('input');
  Object.assign(band, { type: 'number', min: '1', max: '50', step: '1', value: String(DEFAULT_BAND_PERCENT) });
  const controls = new Map();
  const reset = button('Reset preview', () => { initialize(); render(); });
  const save = button('Adopt preview', () => { if (previewTerms && !save.disabled) void adopt(draft, previewTerms); });
  let draft, previewTerms, busy, dirty, preserve = false, notice = '';
  const amountText = minor => (minor / 10 ** moneyDigits(draft.launch.currency)).toFixed(moneyDigits(draft.launch.currency));
  for (const field of LAUNCH_MONEY_FIELDS) {
    const number = element('input'), slider = element('input');
    number.type = 'number'; number.inputMode = 'decimal';
    slider.type = 'range'; slider.step = '1'; slider.setAttribute('aria-label', 'Adjust ' + labels[field]);
    slider.addEventListener('input', () => { number.value = amountText(slider.valueAsNumber); render(); });
    number.addEventListener('input', render);
    controls.set(field, { number, slider }); inputs.append(row(field, number, slider));
  }
  inputs.append(row('bandPercent', band)); band.addEventListener('input', render);

  function initialize(edits = {}) {
    notice = ''; band.value = String(DEFAULT_BAND_PERCENT);
    if (!draft?.launch || invalidLaunchFields(draft.launch).length) return;
    for (const [field, { number, slider }] of controls) {
      const min = field === 'priceMinor' ? 1 : 0;
      slider.min = String(min);
      slider.max = String(Math.min(MAXIMUM_AMOUNT_MINOR, Math.max(draft.launch[field] * 2, 10 ** moneyDigits(draft.launch.currency) * 10)));
      Object.assign(number, { min: amountText(min), step: amountText(1), max: amountText(MAXIMUM_AMOUNT_MINOR),
        value: edits[field] ?? amountText(draft.launch[field]) });
    }
  }

  function renderComparison({ saved, preview, deltas, ranking, bandPercent }) {
    const cards = Object.keys(deltas).filter(field => field !== 'breakEvenReason').map(field => {
      const display = value => value === null ? 'Not reachable'
        : field === 'breakEvenSales' ? String(value) : formatMoney(value, saved.currency);
      const delta = deltas[field];
      return { id: field, title: labels[field],
        description: 'Saved ' + display(saved[field]) + ' · Preview ' + display(preview[field]), content: 'Change ' + (delta > 0 ? '+' : '') + display(delta) };
    });
    const table = element('table'), caption = element('caption', `Effect on estimated net after ten sales at ±${bandPercent}% of each preview driver`);
    table.append(caption);
    const header = table.createTHead().insertRow();
    for (const text of ['Driver', 'Swing']) header.append(element('th', text));
    const body = table.createTBody();
    for (const { field, swing } of ranking) {
      const tr = body.insertRow();
      const th = element('th', labels[field]); th.scope = 'row'; tr.append(th);
      tr.insertCell().textContent = formatMoney(swing, saved.currency);
    }
    result.replaceChildren(DashboardCardGrid({ ariaLabel: 'Saved and preview estimates', cards, columns: 2 }), table);
  }

  function render() {
    previewTerms = null; save.disabled = true; result.replaceChildren();
    const missing = invalidLaunchFields(draft?.launch).filter(field => field !== 'launch');
    const unavailable = !draft ? 'Save an offer with launch terms to simulate it.'
      : isArchived(draft) ? 'Restore this listing before simulating terms.'
      : dirty ? 'Save your editor changes or reopen the saved offer to simulate it.'
      : missing.length ? 'Complete the saved terms for ' + missing.map(field => labels[field]).join(', ') + '.' : '';
    if (unavailable) { host.replaceChildren(status); status.textContent = unavailable; return; }
    if (inputs.parentNode !== host) host.replaceChildren(status, inputs, result, reset, save);
    let field;
    try {
      const { currency } = draft.launch, overrides = {};
      for (const [key, { number, slider }] of controls) {
        field = key; number.removeAttribute('aria-invalid');
        const value = parseMoney(number.value, currency);
        overrides[key] = value;
        slider.max = String(Math.max(Number(slider.max), value)); slider.value = String(value);
        slider.setAttribute('aria-valuetext', formatMoney(value, currency));
      }
      field = 'bandPercent'; band.removeAttribute('aria-invalid');
      const model = compareOfferDrivers({ saved: draft.launch, preview: overrides, bandPercent: band.valueAsNumber });
      renderComparison(model);
      previewTerms = { ...draft.launch, ...overrides };
      save.disabled = busy || LAUNCH_MONEY_FIELDS.every(key => overrides[key] === draft.launch[key]);
      status.textContent = [notice, `Revision ${draft.revision} · ${currency}. Estimates only. Demand is ${model.flags.demandStatus}.`,
        model.preview.constraints.length ? 'The preview price does not cover per-sale costs.' : ''].filter(Boolean).join(' ');
    } catch (error) {
      field = error.field ?? field;
      (controls.get(field)?.number ?? band).setAttribute('aria-invalid', 'true');
      const message = field === 'bandPercent' ? 'Enter a whole percentage from 1 to 50.'
        : field === 'priceMinor' && error.code ? 'Enter a positive price.' : error.message;
      status.textContent = labels[field] + ' — ' + message;
    }
    reset.disabled = busy;
  }

  return {
    keepEditsOnReload() { preserve = true; },
    update(nextDraft, state) {
      const changed = nextDraft !== draft;
      if (changed) {
        const edits = {}, previousBand = band.value, previousCurrency = draft?.launch?.currency;
        if (preserve && draft?.id === nextDraft?.id && draft?.launch) {
          for (const [field, { number }] of controls) {
            if (number.value !== amountText(draft.launch[field])) edits[field] = number.value;
          }
        }
        draft = nextDraft; initialize(edits);
        if (preserve) {
          band.value = previousBand;
          notice = 'Saved terms changed. Review your preview before adopting again.';
          if (draft?.launch && previousCurrency !== draft.launch.currency)
            notice += ` Currency changed from ${previousCurrency} to ${draft.launch.currency}. Check each amount.`;
        }
        preserve = false;
      }
      if (changed || busy !== state.busy || dirty !== state.dirty || !host.childElementCount) {
        ({ busy, dirty } = state); render();
      }
    },
  };
}
