import { buildSettingsKeyTooltip, buildSettingsValueTooltip } from './hover-text.js'
import { createKeyTypeValueRow } from './key-type-value.js'
import { createDesignIcon } from './toolbar-icons.js'
import { applySmePatch, baselineProposal, confirmBaseline, validateDecisionPolicy, sameDecisionPolicy } from './sme-business-pack-core.js?v=business-plan-contract-v6'
export function createSmeWorkflowEditor({
  workflowEditor, inputFields, evidenceEditor, heading, note, evidenceHeading, parameterDetails,
  workflowStatus, getFields, getProtocol, getMode, getSlots, getSelectedSlot, getEvidenceField, setEvidenceField,
  node, option, enumLabel, formatFieldValue, formatMoney, invalidate, getDecision, setDecision, getReports,
}) {
  let activeParameter = null, proposal = null, policyField = 'price_per_unit'
  const decisionPanel = document.createElement('section'); decisionPanel.id = 'sme-decision-panel'; decisionPanel.className = 'decision-panel'
  inputFields.before(decisionPanel)
  let showParameter = () => {}
  inputFields.addEventListener('focusin', event => {
    const field = getFields().find(row => row.name === event.target?.dataset.input)
    if (field) showParameter(field)
  })

  function isRequired(field, mode, inputs) {
    return Boolean(field.required || field.required_modes?.includes(mode?.id)
      || field.required_when && inputs[field.required_when.field] === field.required_when.equals)
  }

  function typedField(wrap, field) {
    const keyNode = wrap.querySelector(':scope > label, :scope > .field-label')
    if (!keyNode) throw Error('sme_typed_field_label_missing')
    keyNode.title = buildSettingsKeyTooltip({ area: 'Business plan', key: field.label,
      responsibility: 'record your planning facts and assumptions without treating unknown facts as zero',
      role: 'Plan owner', actions: ['review ' + field.label, 'enter your own facts and assumptions'], outcome: 'inspect the same local planning inputs across views' })
    keyNode.tabIndex = 0
    for (const control of wrap.querySelectorAll('input, select')) {
      control.title = buildSettingsValueTooltip({ key: field.name, type: control.type === 'number' ? 'number' : field.type,
        defaultValue: null, defaultValueOverride: 'Not declared',
        ...(control.type === 'number' ? { min: control.min, max: control.max, interval: control.step } : {}),
        impact: 'Your recorded planning input; unknown facts remain unknown. Evidence is not authenticated.' })
    }
    wrap.title = wrap.querySelector('input, select')?.title || ''
    const typeNode = createDesignIcon(['money', 'integer'].includes(field.type) ? 'Hash' : 'Type', wrap.ownerDocument)
    typeNode.removeAttribute('aria-hidden'); typeNode.setAttribute('role', 'img')
    typeNode.setAttribute('aria-label', { money: 'Amount or range', integer: 'Whole number', enum: 'Choice', boolean: 'Yes or no', currency: 'Currency code', text: 'Text' }[field.type])
    return createKeyTypeValueRow({ keyNode, typeNode, valueNode: wrap, ownerDocument: wrap.ownerDocument })
  }

  function inputControl(field, prefix, protocol, currencyCode, mode, inputs) {
    const wrap = node('section', undefined, 'field'), label = node('label', field.label + (field.unit ? ' · ' + field.unit : ''))
    const id = prefix + '-' + field.name, scope = prefix === 'compare-evidence' ? 'Evidence value' : `${mode?.row_label ?? 'Plan option'} ${prefix.at(-1).toUpperCase()}`
    const required = isRequired(field, mode, inputs)
    if (field.type === 'enum' || field.type === 'boolean') {
      const control = node('select'); control.id = id; control.dataset.input = field.name; control.autocomplete = 'off'
      option(control, '', 'Choose…')
      const values = field.type === 'boolean' ? [['true', 'Yes'], ['false', 'No']] : field.values.map(value => [value, enumLabel(value)])
      for (const value of values) option(control, value[0], value[1])
      label.htmlFor = id; control.setAttribute('aria-label', `${scope} ${field.label}`); control.setAttribute('aria-required', String(required)); wrap.append(label, control); return typedField(wrap, field)
    }
    if (field.type === 'text' || field.type === 'currency') {
      const control = node('input'); control.type = 'text'; control.id = id; control.dataset.input = field.name
      control.autocomplete = 'off'; control.maxLength = field.type === 'currency' ? 3 : field.max_length ?? 280
      control.autocapitalize = field.type === 'currency' ? 'characters' : 'sentences'
      if (field.type === 'currency') control.placeholder = 'ABC'
      control.setAttribute('aria-label', `${scope} ${field.label}`); control.setAttribute('aria-required', String(required))
      label.htmlFor = id; wrap.append(label, control); return typedField(wrap, field)
    }
    if (field.type === 'money') {
      const currency = protocol?.pack.currency ?? currencyCode
      const range = node('div', undefined, 'cash-range-input')
      const heading = node('span', field.label + ' · ' + (currency || 'selected currency code'), 'field-label')
      range.setAttribute('role', 'group'); range.setAttribute('aria-label', field.label + ' range')
      for (const bound of ['low', 'high']) {
        const control = node('input'); control.type = 'number'; control.min = '0'; control.max = '1000000000'; control.step = '0.0001'
        control.inputMode = 'numeric'; control.autocomplete = 'off'
        control.id = id + '-' + bound; control.dataset.input = field.name; control.dataset.bound = bound
        control.setAttribute('aria-label', `${scope} ${field.label} ${bound === 'low' ? 'minimum' : 'maximum'} amount in ${currency || 'selected currency'}${bound === 'high' ? ' (optional)' : ''}`)
        control.setAttribute('aria-required', String(required && bound === 'low'))
        control.placeholder = bound === 'low' ? 'Amount' : 'Optional'
        const boundLabel = node('label', `${bound === 'low' ? 'Minimum' : 'Maximum'} · ${currency || 'selected currency'}`, 'cash-bound')
        boundLabel.htmlFor = control.id; boundLabel.append(control); range.append(boundLabel)
      }
      const hint = node('span', 'Enter one amount or a low–high range in the selected currency; leave maximum blank for one amount.', 'field-help')
      hint.id = id + '-range-help'
      for (const control of range.querySelectorAll('input')) control.setAttribute('aria-describedby', hint.id)
      wrap.append(heading, range, hint); return typedField(wrap, field)
    }
    const control = node('input'); control.type = 'number'; control.step = '1'; control.inputMode = 'numeric'
    control.min = String(field.min ?? 0); control.max = String(field.max ?? 100000000)
    control.id = id; control.dataset.input = field.name; control.autocomplete = 'off'
    label.htmlFor = id; control.setAttribute('aria-label', `${scope} ${label.textContent}`); control.setAttribute('aria-required', String(required)); wrap.append(label, control); return typedField(wrap, field)
  }

  function readValue(field, prefix, scope) {
    const id = prefix + '-' + field.name, raw = (field.type === 'money' ? scope.querySelector('#' + id + '-low') : scope.querySelector('#' + id))?.value
    if (field.type === 'enum' || field.type === 'boolean') return raw === '' || raw === undefined ? undefined : field.type === 'boolean' ? raw === 'true' : raw
    if (field.type === 'money') {
      const highText = scope.querySelector('#' + id + '-high')?.value
      if (raw === '' || raw === undefined) return undefined
      const low = Number(raw), high = highText === '' ? low : Number(highText)
      return highText === '' ? low : { low, high }
    }
    if (field.type === 'text') return raw === undefined || raw.trim() === '' ? undefined : raw
    if (field.type === 'currency') return raw === undefined || raw.trim() === '' ? undefined : raw.trim().toUpperCase()
    return raw === '' || raw === undefined ? undefined : Number(raw)
  }

  function writeValue(field, prefix, value, scope) {
    const id = prefix + '-' + field.name
    if (field.type === 'money') {
      const range = value === undefined ? null : typeof value === 'number' ? { low: value, high: value } : value
      const low = scope.querySelector('#' + id + '-low'), high = scope.querySelector('#' + id + '-high')
      if (low) low.value = range ? String(range.low) : ''
      if (high) high.value = range && range.high !== range.low ? String(range.high) : ''
    } else {
      const control = scope.querySelector('#' + id)
      if (control) control.value = value === undefined ? '' : String(value)
    }
  }

  function guidance(field, protocol, mode, inputs) {
    const details = node('dl', undefined, 'workflow-parameter-grid')
    const add = (name, value) => { const row = node('div'); row.append(node('dt', name), node('dd', value)); details.append(row) }
    const target = protocol?.protocols?.find(row => row.field_key === field.name)
    const lines = (protocol?.model_outputs ?? []).filter(row => row.inputs.includes(field.name))
    const currency = protocol?.pack.currency ?? getSlots().find(row => row.slot === getSelectedSlot())?.inputs.currency_code
    const bounds = field.type === 'money' ? `0–${formatMoney(1000000000, currency)} · up to 4 decimal places; single value or range`
      : field.type === 'integer' ? `${field.min ?? 0}–${field.max ?? 'no upper limit'}${field.unit ? ' ' + field.unit : ''} · whole numbers`
        : field.type === 'currency' ? 'Three uppercase letters; user-selected; no conversion is applied'
          : field.type === 'text' ? `Up to ${field.max_length ?? 280} characters; no URL or email`
        : field.type === 'enum' ? field.values.map(enumLabel).join(' · ')
          : field.type === 'boolean' ? 'Yes · No' : field.type
    add('Section', field.section ?? 'Plan')
    add('Parameter', field.label + (field.unit ? ' · ' + field.unit : ''))
    add('Input', field.type === 'money' ? `Amount · ${currency || 'selected currency'}` : field.type === 'integer' ? `Whole number${field.unit ? ' · ' + field.unit : ''}` : field.type === 'enum' ? 'Choose one' : field.type === 'currency' ? 'Currency code' : field.type === 'text' ? 'Short text' : 'Yes or no')
    const required = isRequired(field, mode, inputs)
    add('Completeness', required ? 'Required for this mode or selected path · blank stays unknown' : 'Optional input')
    if (field.required_modes?.length) add('Mode scope', `Required in: ${field.required_modes.map(id => protocol.plan_modes.find(item => item.id === id)?.label ?? id).join(', ')}`)
    if (field.required_when) add('Path condition', `Required when ${field.required_when.field} is ${field.required_when.equals}`)
    add(field.type === 'enum' || field.type === 'boolean' ? 'Allowed values' : field.type === 'money' || field.type === 'integer' || field.type === 'currency' || field.type === 'text' ? 'Entry limits' : 'Entry rule', bounds)
    if (lines.length) add('Model use', lines.map(line => `${line.id} · ${line.label} (${line.formula})`).join(' · '))
    add('Evidence target', target ? 'User-recorded context; not authenticated' : 'No evidence guidance defined for this input')
    if (target) add('Next evidence check', target.task)
    return details
  }

  function renderEvidence(item, fields, protocol) {
    evidenceEditor.replaceChildren()
    const evidenceFields = fields.filter(field => protocol?.protocols?.some(row => row.field_key === field.name))
    if (!evidenceFields.length) { evidenceEditor.append(node('p', 'No evidence guidance is defined for this plan.', 'muted')); return }
    let selected = evidenceFields.find(field => field.name === getEvidenceField()) ?? evidenceFields[0]
    setEvidenceField(selected.name)
    const scope = `${getMode()?.row_label ?? 'Plan option'} ${item.slot}`
    evidenceHeading.textContent = `Evidence for ${selected.label} · ${scope}`
    const fieldWrap = node('section', undefined, 'field'), fieldLabel = node('label', 'Evidence field'), fieldSelect = node('select')
    fieldSelect.id = 'sme-evidence-field'; fieldLabel.htmlFor = fieldSelect.id
    for (const field of evidenceFields) option(fieldSelect, field.name, field.label + (field.unit ? ' · ' + field.unit : ''))
    fieldSelect.value = selected.name
    fieldSelect.setAttribute('aria-label', `Evidence field for ${scope}`)
    fieldSelect.addEventListener('change', () => { setEvidenceField(fieldSelect.value); renderEvidence(item, fields, protocol) })
    fieldWrap.append(fieldLabel, fieldSelect)

    const provenance = node('select'); provenance.id = 'sme-evidence-provenance'; option(provenance, '', 'Evidence source…')
    for (const row of [['assumption', 'Assumption'], ['self_reported', 'Self reported'], ['directly_observed', 'Directly observed'], ['counted', 'Counted'], ['document_reviewed', 'Document reviewed'], ['independently_reported', 'Independently reported']]) option(provenance, row[0], row[1])
    const role = node('select'); role.id = 'sme-evidence-role'; option(role, '', 'Observer role…')
    for (const name of ['author', 'observer', 'reviewer']) option(role, name, name)
    const date = node('input'); date.type = 'date'; date.id = 'sme-evidence-date'
    const metadata = node('div', undefined, 'evidence-fields')
    for (const [control, labelText] of [[provenance, 'Provenance'], [role, 'Observer'], [date, 'Date']]) {
      const wrap = node('section', undefined, 'field'), label = node('label', labelText)
      label.htmlFor = control.id; wrap.append(label, control); metadata.append(wrap)
    }
    const valuePrefix = 'compare-evidence', valueControl = inputControl(selected, valuePrefix, protocol, item.inputs.currency_code)
    const list = node('ul', undefined, 'sme-evidence-list'), add = node('button', 'Add evidence'); add.type = 'button'; add.id = 'sme-evidence-add'
    const renderRows = () => {
      list.replaceChildren()
      item.evidence.forEach((row, index) => {
        if (row.field_key !== selected.name) return
        const entry = node('li', `${formatFieldValue(selected, row.value, item.inputs.currency_code)} · ${row.provenance.replaceAll('_', ' ')} · ${row.observer_role.replaceAll('_', ' ')} · ${row.date}`)
        const remove = node('button', 'Remove'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${selected.label} evidence`)
        remove.addEventListener('click', () => { item.evidence.splice(index, 1); invalidate(); render() })
        entry.append(remove); list.append(entry)
      })
    }
    add.addEventListener('click', () => {
      const value = readValue(selected, valuePrefix, evidenceEditor)
      if (value === undefined || !provenance.value || !role.value || !date.value || item.evidence.length >= 40) {
        workflowStatus.textContent = item.evidence.length >= 40 ? 'A plan row can include at most 40 evidence entries.'
          : 'Choose a value, provenance, observer and date before adding evidence.'; return
      }
      item.evidence.push({ field_key: selected.name, value, provenance: provenance.value, observer_role: role.value, date: date.value })
      invalidate(); render()
    })
    evidenceEditor.append(fieldWrap, metadata, valueControl, add, list); renderRows()
  }

  function render() {
    const item = getSlots().find(row => row.slot === getSelectedSlot()), fields = getFields(), protocol = getProtocol()
    workflowEditor.hidden = !item
    inputFields.replaceChildren(); evidenceEditor.replaceChildren()
    if (!item) { decisionPanel.replaceChildren(); return }
    renderDecision()
    const mode = getMode(), scope = `${mode?.row_label ?? 'Plan option'} ${item.slot}`
    heading.textContent = `Edit · ${scope}`
    note.textContent = `Edit every table field for this ${mode?.row_label?.toLowerCase() ?? 'plan option'}. Blank stays unknown; values and evidence records stay in this tab and are not authenticated.`
    const fallback = fields[0]
    activeParameter = fields.some(field => field.name === activeParameter) ? activeParameter : fallback?.name ?? null
    showParameter = field => { activeParameter = field.name; parameterDetails.replaceChildren(guidance(field, protocol, mode, item.inputs)) }
    if (fields.length) showParameter(fields.find(field => field.name === activeParameter) ?? fields[0])
    const fieldset = node('fieldset', undefined, 'workflow-edit-set'), grid = node('div', undefined, 'agentic-ktv-container')
    fieldset.append(node('legend', scope), grid)
    const prefix = 'compare-' + item.slot.toLowerCase()
    for (const field of fields) {
      const control = inputControl(field, prefix, protocol, item.inputs.currency_code, mode, item.inputs)
      writeValue(field, prefix, item.inputs[field.name], control)
      for (const input of control.querySelectorAll('input, select')) input.addEventListener(input instanceof HTMLSelectElement ? 'change' : 'input', () => {
        const value = readValue(field, prefix, control)
        try {
          const next = applySmePatch(item, { [field.name]: value === undefined ? null : value }, getDecision(),
            { revision: item.revision, policy_revision: getDecision()?.policy_revision ?? 0 }, fields)
          Object.assign(item, next); invalidate()
          if (field.name === 'buy_build_path') render()
        } catch (error) { writeValue(field, prefix, item.inputs[field.name], control); showRefusal(error) }
      })
      grid.append(control)
    }
    inputFields.append(fieldset)
    renderEvidence(item, fields, protocol)
  }

  function describeRefusal(error) {
    const meanings = { protected: 'is protected', outside_bounds: 'is outside its permitted range', invalid_value: 'has an invalid value',
      stale: 'changed after the request; review it again', stale_or_unconfirmed: 'changed after the request; review it again',
      invalid_bounds: 'needs a valid minimum and maximum', invalid_policy: 'needs a valid owner policy' }
    return error.reasons?.map(row => `${getFields().find(field => field.name === row.field)?.label ?? (row.field === 'baseline' ? 'Baseline' : 'Decision policy')} ${meanings[row.reason] ?? 'needs review'}`).join(' · ') || 'Review the current inputs and policy.'
  }
  function showRefusal(error) { workflowStatus.textContent = 'Change refused. ' + describeRefusal(error) }
  function renderDecision() {
    decisionPanel.replaceChildren()
    const rows = getSlots(), selected = getSelectedSlot(), policy = getDecision(), reports = getReports()
    const report = reports?.slots.find(row => row.slot === selected)?.report
    const button = (label, id, action) => {
      const element = node('button', label, 'secondary'); element.type = 'button'; element.id = id; element.addEventListener('click', action); return element
    }
    const current = () => getSlots().map(({ slot, inputs, evidence, revision }) => ({ slot, inputs, evidence, revision }))
    const title = node('h3', 'Decision rehearsal'), status = node('p', policy ? `Baseline ${policy.baseline} · policy revision ${policy.policy_revision}` : getMode()?.id === 'scenario'
      ? 'No baseline selected. Build a plan, select its row, then request a baseline.' : 'Build this plan to inspect its calculations. Choose Scenario mode to request a baseline and set owner constraints.')
    status.id = 'sme-baseline-status'
    const actions = node('div', undefined, 'actions')
    decisionPanel.append(title, status)
    if (getMode()?.id === 'scenario' || policy) {
      const request = button('Request selected row as baseline', 'sme-baseline-request', () => {
        try { proposal = baselineProposal(selected, current(), getDecision()); renderDecision(); decisionPanel.querySelector('#sme-baseline-confirm')?.focus() } catch (error) { showRefusal(error) }
      })
      request.disabled = !report || report.check.completeness.invalid_fields.length > 0
      actions.append(request)
      if (policy) actions.append(button('Clear baseline and protections', 'sme-decision-clear', () => { proposal = null; setDecision(null); renderDecision() }))
      decisionPanel.append(actions)
      if (proposal) {
        const review = node('section', undefined, 'decision-review'); review.setAttribute('aria-label', 'Baseline change review')
        review.append(node('p', `Use row ${proposal.slot} as the baseline? Review the current facts and policy before confirming. This changes only this local worksheet.`),
          button('Confirm baseline', 'sme-baseline-confirm', () => {
            try { setDecision(confirmBaseline(proposal, current(), getDecision(), true)); proposal = null; renderDecision(); decisionPanel.querySelector('#sme-baseline-request')?.focus() }
            catch (error) { proposal = null; renderDecision(); showRefusal(error) }
          }), button('Decline baseline change', 'sme-baseline-decline', () => { proposal = null; renderDecision(); decisionPanel.querySelector('#sme-baseline-request')?.focus(); workflowStatus.textContent = 'Baseline change declined. Current facts and baseline are retained.' }))
        decisionPanel.append(review)
      }
      if (policy) {
        const fields = getFields(), picker = node('select'); picker.id = 'sme-protected-field'; picker.setAttribute('aria-label', 'Decision policy field')
        for (const field of fields) option(picker, field.name, field.label)
        if (fields.some(field => field.name === policyField)) picker.value = policyField
        picker.addEventListener('change', () => { policyField = picker.value })
        const low = node('input'), high = node('input')
        for (const [input, label] of [[low, 'Minimum permitted value'], [high, 'Maximum permitted value']]) {
          input.type = 'number'; input.min = '0'; input.max = '1000000000'; input.step = '0.0001'; input.setAttribute('aria-label', label)
        }
        const editPolicy = change => {
          try {
            const next = structuredClone(getDecision()); change(next, picker.value); next.policy_revision++
            validateDecisionPolicy(next, fields, rows.map(row => row.slot)); setDecision(next); renderDecision()
          } catch (error) { showRefusal(error) }
        }
        const fieldLabel = node('label', 'Constraint field'), minimum = node('label', 'Minimum permitted value'), maximum = node('label', 'Maximum permitted value')
        fieldLabel.append(picker); minimum.append(low); maximum.append(high)
        const editor = node('fieldset', undefined, 'decision-policy'); editor.append(node('legend', 'Owner constraints'), fieldLabel,
          button('Protect field', 'sme-protect-field', () => editPolicy((next, key) => { if (!next.protected_fields.includes(key)) next.protected_fields.push(key) })),
          button('Unlock field', 'sme-unlock-field', () => editPolicy((next, key) => { next.protected_fields = next.protected_fields.filter(value => value !== key) })),
          minimum, maximum, button('Set permitted range', 'sme-bound-field', () => {
            if (!low.value.trim() || !high.value.trim()) { workflowStatus.textContent = 'Enter both permitted bounds; a blank bound is unknown.'; return }
            editPolicy((next, key) => { next.bounds[key] = { min: Number(low.value), max: Number(high.value) } })
          }), button('Remove permitted range', 'sme-bound-clear', () => editPolicy((next, key) => { delete next.bounds[key] })))
        const fieldLabelFor = key => fields.find(field => field.name === key)?.label ?? key
        const details = node('p', `Protected: ${policy.protected_fields.map(fieldLabelFor).join(', ') || 'none'}. Permitted ranges: ${Object.entries(policy.bounds).map(([key, value]) => `${fieldLabelFor(key)} ${value.min}–${value.max}`).join('; ') || 'none'}. Bounds use the field’s declared unit. Unknown facts are never zero.`)
        details.id = 'sme-policy-status'; editor.append(details); decisionPanel.append(editor)
      }
    }
    const working = node('details'); working.id = 'sme-working'
    working.append(node('summary', 'Show calculation working'))
    if (!report) working.append(node('p', 'Build the current plan to inspect its working.'))
    else {
      working.append(node('p', report.working.range_basis + ' · Evidence is user-recorded and not authenticated.'))
      const deltas = reports.decision?.rows.find(row => row.slot === selected)?.deltas
      const deltaText = delta => !delta.value ? 'Unknown' : `${delta.value.low === delta.value.high ? delta.value.low : delta.value.low + ' to ' + delta.value.high} ${delta.unit}`
      for (const output of getProtocol().model_outputs) {
        const entry = report.working.outputs[output.id], section = node('details'), delta = deltas?.[output.id]
        const change = delta ? ` · Change from baseline ${reports.decision.baseline}: ${deltaText(delta)}` : ''
        const summary = node('summary', `${output.label}: ${report.model_display[output.id]}${change}`)
        section.append(summary, node('p', `${entry.formula} · Unit: ${entry.unit} · Period: ${entry.period} · ${enumLabel(entry.status)}`))
        if (deltas?.[output.id]) {
          const delta = deltas[output.id], value = delta.value
          section.append(node('p', `Change from baseline ${reports.decision.baseline}: ${deltaText(delta)} · ${enumLabel(delta.status)}`))
        }
        const list = node('ul')
        for (const key of entry.fields) {
          const operand = report.working.operands[key], field = getFields().find(row => row.name === key)
          const value = operand.value === null ? 'Unknown' : formatFieldValue(field, operand.value, report.model.currency_code)
          const sources = operand.evidence.map(row => `${row.provenance}, ${row.date}, ${row.observer_role}, value ${JSON.stringify(row.value)}`).join('; ') || 'No dated evidence recorded'
          list.append(node('li', `${field?.label ?? key}: ${value} · ${sources}`))
        }
        section.append(list); working.append(section)
      }
    }
    decisionPanel.append(working)
  }
  function validateImport(worksheets) {
    const policy = getDecision()
    if (!policy) return
    if (worksheets.some(sheet => !sameDecisionPolicy(sheet.decision, policy))) throw Error('sme_pack_decision_refused')
    for (const [index, item] of getSlots().entries()) {
      const sheet = worksheets[index]
      if (!sheet) throw Error('sme_pack_decision_refused')
      const patch = Object.fromEntries(getFields().map(field => [field.name, sheet.inputs[field.name] ?? null]))
      applySmePatch(item, patch, policy, { revision: item.revision, policy_revision: policy.policy_revision }, getFields())
    }
  }
  return { render, describeRefusal, refreshDecision: renderDecision, validateImport, resetDecision: () => { proposal = null } }

}
