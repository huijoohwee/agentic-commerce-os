import { buildSettingsKeyTooltip, buildSettingsValueTooltip } from './hover-text.js'
import { createKeyTypeValueRow, createKeyTypeValueRows } from './key-type-value.js'
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

  function fieldCells(wrap, field) {
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
    const typeNode = createDesignIcon(['money', 'integer'].includes(field.type) ? 'Hash' : field.type === 'date' ? 'CalendarClock' : field.type === 'file' ? 'FileInput' : field.type === 'action' ? 'Play' : 'Type', wrap.ownerDocument)
    typeNode.removeAttribute('aria-hidden'); typeNode.setAttribute('role', 'img')
    typeNode.setAttribute('aria-label', { money: 'Amount', integer: 'Whole number', enum: 'Choice', boolean: 'Yes or no', currency: 'Currency code', text: 'Text', date: 'Date', file: 'File', action: 'Action' }[field.type])
    return { keyNode, typeNode, valueNode: wrap }
  }

  function typedField(wrap, field) {
    return createKeyTypeValueRow({ ...fieldCells(wrap, field), ownerDocument: wrap.ownerDocument })
  }

  function controlRow(control, text, type = 'text', existingLabel) {
    const wrap = node('section', undefined, 'field')
    const label = existingLabel ?? node(type === 'action' ? 'span' : 'label', text, type === 'action' ? 'field-label' : undefined)
    const trigger = control.parentElement?.querySelector('[data-agentic-select-for="' + control.id + '"]')
    if (type !== 'action') { control.id ||= 'sme-control-' + text.toLowerCase().replace(/[^a-z0-9]+/g, '-'); label.htmlFor = trigger?.id || control.id }
    wrap.append(label, control); if (trigger) wrap.append(trigger)
    return typedField(wrap, { name: control.id, label: text, type })
  }

  const form = workflowEditor.closest('form')
  for (const [id, type] of [['sme-plan-mode', 'enum'], ['pack-id', 'enum'], ['sme-compare-count', 'enum'], ['sme-edit-slot', 'enum'],
    ['sme-review-view', 'enum'], ['sme-review-start', 'date'], ['sme-review-end', 'date']]) {
    const control = form.querySelector('#' + id), trigger = form.querySelector('[data-agentic-select-for="' + id + '"]'),
      label = form.querySelector('label[for="' + (trigger?.id || id) + '"]'), marker = node('span')
    if (!control || !label) throw Error('sme_workflow_control_missing:' + id)
    label.before(marker); marker.replaceWith(controlRow(control, label.textContent, type, label))
  }
  for (const [id, text] of [['sme-compare-run', 'Plan calculation'], ['sample', 'Illustrative inputs'], ['sme-workflow-pivot', 'Field metadata'], ['sme-review-export', 'View notes']]) {
    const control = form.querySelector('#' + id), marker = node('span')
    control.before(marker); marker.replaceWith(controlRow(control, text, 'action'))
  }

  const workspace = workflowEditor.closest('.workspace-content')
  for (const id of ['sme-review-import', 'sme-worksheet-import']) {
    const control = workspace.querySelector('#' + id), label = workspace.querySelector('label[for="' + id + '"]'), marker = node('span')
    label.before(marker); label.className = ''; control.classList.remove('file-input')
    marker.replaceWith(controlRow(control, label.textContent, 'file', label))
  }
  for (const control of workspace.querySelectorAll('#sme-worksheet-actions button')) {
    const marker = node('span'); control.before(marker); marker.replaceWith(controlRow(control, control.textContent, 'action'))
  }
  for (const group of workspace.querySelectorAll('.actions')) group.className = 'agentic-ktv-container'

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
      const hint = node('span', 'Enter one amount or a low–high range in the selected currency; leave maximum blank for one amount.', 'field-help')
      hint.id = id + '-range-help'
      const rows = ['low', 'high'].map(bound => {
        const value = node('section', undefined, 'field'), boundName = bound === 'low' ? 'Minimum' : 'Maximum'
        const control = node('input'); control.type = 'number'; control.min = '0'; control.max = '1000000000'; control.step = '0.0001'
        control.inputMode = 'numeric'; control.autocomplete = 'off'
        control.id = id + '-' + bound; control.dataset.input = field.name; control.dataset.bound = bound
        control.setAttribute('aria-label', `${scope} ${field.label} ${bound === 'low' ? 'minimum' : 'maximum'} amount in ${currency || 'selected currency'}${bound === 'high' ? ' (optional)' : ''}`)
        control.setAttribute('aria-required', String(required && bound === 'low'))
        control.setAttribute('aria-describedby', hint.id)
        control.placeholder = bound === 'low' ? 'Amount' : 'Optional'
        const boundField = { ...field, label: `${boundName} · ${field.label} · ${currency || 'selected currency code'}` }
        const boundLabel = node('label', boundField.label); boundLabel.htmlFor = control.id
        value.append(boundLabel, control)
        return { id: control.id + '-row', ...fieldCells(value, boundField) }
      })
      const group = createKeyTypeValueRows({ rows, ownerDocument: wrap.ownerDocument })
      group.append(hint); return group
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

  function readOnlyCells(label, value, type = 'text') {
    const keyNode = node('span', label), valueNode = node('span', value)
    const typeNode = createDesignIcon(['number', 'money', 'integer'].includes(type) ? 'Hash' : type === 'date' ? 'CalendarClock' : 'Type')
    keyNode.title = label; keyNode.tabIndex = 0
    typeNode.removeAttribute('aria-hidden'); typeNode.setAttribute('role', 'img')
    typeNode.setAttribute('aria-label', { number: 'Number', money: 'Amount', integer: 'Whole number', date: 'Date' }[type] || 'Text')
    return { keyNode, typeNode, valueNode, align: 'start' }
  }

  function guidance(field, protocol, mode, inputs) {
    const details = node('section', undefined, 'agentic-ktv-container')
    const add = (name, value) => details.append(createKeyTypeValueRow(readOnlyCells(name, value)))
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
    const metadata = node('div', undefined, 'agentic-ktv-container')
    for (const [control, labelText] of [[provenance, 'Provenance'], [role, 'Observer'], [date, 'Date']]) {
      const wrap = node('section', undefined, 'field'), label = node('label', labelText)
      label.htmlFor = control.id; wrap.append(label, control); metadata.append(typedField(wrap, { name: control.id, label: labelText, type: control === date ? 'date' : 'enum' }))
    }
    const valuePrefix = 'compare-evidence', valueControl = inputControl(selected, valuePrefix, protocol, item.inputs.currency_code)
    const list = node('ul', undefined, 'sme-evidence-list'), add = node('button', 'Add evidence'); add.type = 'button'; add.id = 'sme-evidence-add'
    const renderRows = () => {
      list.replaceChildren()
      item.evidence.forEach((row, index) => {
        if (row.field_key !== selected.name) return
        const entry = node('li'), values = [['Value', formatFieldValue(selected, row.value, item.inputs.currency_code)],
          ['Provenance', row.provenance.replaceAll('_', ' ')], ['Observer', row.observer_role.replaceAll('_', ' ')], ['Date', row.date]]
        entry.append(createKeyTypeValueRows({ rows: values.map(([keyNode, valueNode], part) => {
          const typeNode = createDesignIcon('Type'); typeNode.removeAttribute('aria-hidden'); typeNode.setAttribute('role', 'img'); typeNode.setAttribute('aria-label', 'Text')
          return { id: 'sme-evidence-' + index + '-' + part, keyNode, typeNode, valueNode }
        }) }))
        const remove = node('button', 'Remove'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${selected.label} evidence`)
        remove.addEventListener('click', () => { item.evidence.splice(index, 1); invalidate(); render() })
        entry.append(controlRow(remove, 'Remove evidence', 'action')); list.append(entry)
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
    evidenceEditor.append(typedField(fieldWrap, { name: fieldSelect.id, label: 'Evidence field', type: 'enum' }), metadata, valueControl, controlRow(add, 'Evidence record', 'action'), list); renderRows()
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
    const actions = node('div', undefined, 'agentic-ktv-container')
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
    const fact = (id, label, value, type) => ({ id: 'sme-working-' + id, ...readOnlyCells(label, value, type) })
    if (!report) working.append(createKeyTypeValueRows({ rows: [fact('status', 'Calculation status', 'Build the current plan to inspect its working.')] }))
    else {
      working.append(createKeyTypeValueRows({ rows: [fact('range-basis', 'Range basis', report.working.range_basis),
        fact('evidence-status', 'Evidence status', report.working.evidence_status)] }))
      const deltas = reports.decision?.rows.find(row => row.slot === selected)?.deltas
      const deltaText = delta => !delta.value ? 'Unknown' : `${delta.value.low === delta.value.high ? delta.value.low : delta.value.low + ' to ' + delta.value.high} ${delta.unit}`
      for (const output of getProtocol().model_outputs) {
        const entry = report.working.outputs[output.id], delta = deltas?.[output.id], prefix = output.id + '-'
        const group = node('section'), details = node('details')
        group.dataset.workingOutput = output.id; group.setAttribute('aria-label', output.label)
        const results = [fact(prefix + 'result', output.label, report.model_display[output.id], 'number')]
        if (delta) results.push(fact(prefix + 'delta', 'Change from baseline ' + reports.decision.baseline, deltaText(delta), 'number'),
          fact(prefix + 'delta-status', 'Change status', enumLabel(delta.status)))
        group.append(createKeyTypeValueRows({ rows: results }))
        details.append(node('summary', 'Calculation details · ' + output.label), createKeyTypeValueRows({ rows: [
          fact(prefix + 'formula', 'Formula', entry.formula), fact(prefix + 'unit', 'Unit', entry.unit),
          fact(prefix + 'period', 'Period', entry.period), fact(prefix + 'status', 'Calculation status', enumLabel(entry.status)),
        ] }))
        for (const key of entry.fields) {
          const operand = report.working.operands[key], field = getFields().find(row => row.name === key), inputId = prefix + key + '-'
          const input = node('section'); input.setAttribute('aria-label', 'Input · ' + (field?.label ?? key))
          const value = operand.value === null ? 'Unknown' : formatFieldValue(field, operand.value, report.model.currency_code)
          input.append(createKeyTypeValueRows({ rows: [fact(inputId + 'value', field?.label ?? key, value, field?.type)] }))
          if (!operand.evidence.length) input.append(createKeyTypeValueRows({ rows: [fact(inputId + 'evidence-status', 'Evidence status', 'No dated evidence recorded')] }))
          operand.evidence.forEach((source, index) => {
            const evidence = node('section'), sourceId = inputId + 'evidence-' + index + '-'
            evidence.setAttribute('aria-label', `Evidence ${index + 1} · ${field?.label ?? key}`)
            evidence.append(createKeyTypeValueRows({ rows: [
              fact(sourceId + 'value', 'Recorded value', formatFieldValue(field, source.value, report.model.currency_code), field?.type),
              fact(sourceId + 'provenance', 'Provenance', enumLabel(source.provenance)),
              fact(sourceId + 'observer', 'Observer', enumLabel(source.observer_role)), fact(sourceId + 'date', 'Date', source.date, 'date'),
            ] })); input.append(evidence)
          })
          details.append(input)
        }
        group.append(details); working.append(group)
      }
    }
    for (const label of decisionPanel.querySelectorAll('.decision-policy > label')) {
      const control = label.querySelector('input, select'), marker = node('span'), text = label.firstChild.textContent
      label.before(marker); marker.replaceWith(controlRow(control, text, control.tagName === 'SELECT' ? 'enum' : 'integer', label))
    }
    for (const control of decisionPanel.querySelectorAll('button')) {
      const marker = node('span'); control.before(marker); marker.replaceWith(controlRow(control, control.textContent, 'action'))
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
