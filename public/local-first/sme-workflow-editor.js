export function createSmeWorkflowEditor({
  workflowEditor, inputFields, evidenceEditor, heading, note, evidenceHeading, parameterDetails,
  workflowStatus, getFields, getProtocol, getSlots, getSelectedSlot, getEvidenceField, setEvidenceField,
  node, option, enumLabel, formatFieldValue, formatMoney, invalidate,
}) {
  let activeParameter = null
  let showParameter = () => {}
  inputFields.addEventListener('focusin', event => {
    const field = getFields().find(row => row.name === event.target?.dataset.input)
    if (field) showParameter(field)
  })

  function inputControl(field, prefix, protocol, currencyCode) {
    const wrap = node('section', undefined, 'field'), label = node('label', field.label + (field.unit ? ' · ' + field.unit : ''))
    const id = prefix + '-' + field.name, scope = prefix === 'compare-evidence' ? 'Evidence value' : `Scenario ${prefix.at(-1).toUpperCase()}`
    if (field.type === 'enum' || field.type === 'boolean') {
      const control = node('select'); control.id = id; control.dataset.input = field.name; control.autocomplete = 'off'
      option(control, '', 'Choose…')
      const values = field.type === 'boolean' ? [['true', 'Yes'], ['false', 'No']] : field.values.map(value => [value, enumLabel(value)])
      for (const value of values) option(control, value[0], value[1])
      label.htmlFor = id; control.setAttribute('aria-label', `${scope} ${field.label}`); control.setAttribute('aria-required', String(Boolean(field.required))); wrap.append(label, control); return wrap
    }
    if (field.type === 'text' || field.type === 'currency') {
      const control = node('input'); control.type = 'text'; control.id = id; control.dataset.input = field.name
      control.autocomplete = 'off'; control.maxLength = field.type === 'currency' ? 3 : field.max_length ?? 280
      control.autocapitalize = field.type === 'currency' ? 'characters' : 'sentences'
      if (field.type === 'currency') control.placeholder = 'ABC'
      control.setAttribute('aria-label', `${scope} ${field.label}`); control.setAttribute('aria-required', String(Boolean(field.required)))
      label.htmlFor = id; wrap.append(label, control); return wrap
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
        control.setAttribute('aria-required', String(Boolean(field.required) && bound === 'low'))
        control.placeholder = bound === 'low' ? 'Amount' : 'Optional'
        const boundLabel = node('label', `${bound === 'low' ? 'Minimum' : 'Maximum'} · ${currency || 'selected currency'}`, 'cash-bound')
        boundLabel.htmlFor = control.id; boundLabel.append(control); range.append(boundLabel)
      }
      const hint = node('span', 'Enter one amount or a low–high range in the selected currency; leave maximum blank for one amount.', 'field-help')
      hint.id = id + '-range-help'
      for (const control of range.querySelectorAll('input')) control.setAttribute('aria-describedby', hint.id)
      wrap.append(heading, range, hint); return wrap
    }
    const control = node('input'); control.type = 'number'; control.step = '1'; control.inputMode = 'numeric'
    control.min = String(field.min ?? 0); control.max = String(field.max ?? 100000000)
    control.id = id; control.dataset.input = field.name; control.autocomplete = 'off'
    label.htmlFor = id; control.setAttribute('aria-label', `${scope} ${label.textContent}`); control.setAttribute('aria-required', String(Boolean(field.required))); wrap.append(label, control); return wrap
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

  function guidance(field, protocol) {
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
    add('Completeness', field.required ? 'Required for a complete plan · blank stays unknown' : 'Optional input')
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
    evidenceHeading.textContent = `Evidence for ${selected.label} · Scenario ${item.slot}`
    const fieldWrap = node('section', undefined, 'field'), fieldLabel = node('label', 'Evidence field'), fieldSelect = node('select')
    fieldSelect.id = 'sme-evidence-field'; fieldLabel.htmlFor = fieldSelect.id
    for (const field of evidenceFields) option(fieldSelect, field.name, field.label + (field.unit ? ' · ' + field.unit : ''))
    fieldSelect.value = selected.name
    fieldSelect.setAttribute('aria-label', 'Evidence field for Scenario ' + item.slot)
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
        workflowStatus.textContent = item.evidence.length >= 40 ? 'A scenario can include at most 40 evidence entries.'
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
    if (!item) return
    heading.textContent = `Edit · Scenario ${item.slot}`
    note.textContent = 'Edit every table field for this scenario. Blank stays unknown; values and evidence records stay in this tab and are not authenticated.'
    const fallback = fields[0]
    activeParameter = fields.some(field => field.name === activeParameter) ? activeParameter : fallback?.name ?? null
    showParameter = field => { activeParameter = field.name; parameterDetails.replaceChildren(guidance(field, protocol)) }
    if (fields.length) showParameter(fields.find(field => field.name === activeParameter) ?? fields[0])
    const fieldset = node('fieldset', undefined, 'workflow-edit-set'), grid = node('div', undefined, 'workflow-edit-fields')
    fieldset.append(node('legend', 'Scenario ' + item.slot), grid)
    const prefix = 'compare-' + item.slot.toLowerCase()
    for (const field of fields) {
      const control = inputControl(field, prefix, protocol, item.inputs.currency_code)
      writeValue(field, prefix, item.inputs[field.name], control)
      for (const input of control.querySelectorAll('input, select')) input.addEventListener(input instanceof HTMLSelectElement ? 'change' : 'input', () => {
        const value = readValue(field, prefix, control)
        if (value === undefined) delete item.inputs[field.name]; else item.inputs[field.name] = value
        invalidate()
      })
      grid.append(control)
    }
    inputFields.append(fieldset)
    renderEvidence(item, fields, protocol)
  }

  return { render }
}
