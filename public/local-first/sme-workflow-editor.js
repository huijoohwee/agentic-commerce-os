export function createSmeWorkflowEditor({
  workflowEditor, claimInputs, evidenceEditor, heading, note, evidenceHeading, parameterDetails,
  workflowStatus, getFields, getProtocol, getSlots, getSelectedSlot, getEvidenceField, setEvidenceField,
  node, option, enumLabel, formatClaim, formatMoney, invalidate,
}) {
  let activeParameter = null
  let showParameter = () => {}
  claimInputs.addEventListener('focusin', event => {
    const field = getFields().find(row => row.name === event.target?.dataset.claim)
    if (field) showParameter(field)
  })

  function inputControl(field, prefix, protocol) {
    const wrap = node('section', undefined, 'field'), label = node('label', field.label + (field.unit ? ' · ' + field.unit : ''))
    const id = prefix + '-' + field.name, scope = prefix === 'compare-evidence' ? 'Evidence value' : `Set ${prefix.at(-1).toUpperCase()}`
    if (field.type === 'enum' || field.type === 'boolean') {
      const control = node('select'); control.id = id; control.dataset.claim = field.name; control.autocomplete = 'off'
      option(control, '', 'Choose…')
      const values = field.type === 'boolean' ? [['true', 'Yes'], ['false', 'No']] : field.values.map(value => [value, enumLabel(value)])
      for (const value of values) option(control, value[0], value[1])
      label.htmlFor = id; control.setAttribute('aria-label', `${scope} ${field.label}`); control.setAttribute('aria-required', String(Boolean(field.required))); wrap.append(label, control); return wrap
    }
    if (field.type === 'money') {
      const currency = protocol?.pack.currency || 'SGD', range = node('div', undefined, 'cash-range-input')
      const heading = node('span', field.label + ' · ' + currency, 'field-label')
      range.setAttribute('role', 'group'); range.setAttribute('aria-label', field.label + ' range')
      for (const bound of ['low', 'high']) {
        const control = node('input'); control.type = 'number'; control.min = '0'; control.max = '100000000'; control.step = '1'
        control.inputMode = 'numeric'; control.autocomplete = 'off'
        control.id = id + '-' + bound; control.dataset.claim = field.name; control.dataset.bound = bound
        control.setAttribute('aria-label', `${scope} ${field.label} ${bound === 'low' ? 'minimum' : 'maximum'} amount in ${currency}${bound === 'high' ? ' (optional)' : ''}`)
        control.setAttribute('aria-required', String(Boolean(field.required) && bound === 'low'))
        control.placeholder = bound === 'low' ? 'Amount' : 'Optional'
        const boundLabel = node('label', `${bound === 'low' ? 'Minimum' : 'Maximum'} · ${currency}`, 'cash-bound')
        boundLabel.htmlFor = control.id; boundLabel.append(control); range.append(boundLabel)
      }
      const hint = node('span', 'Whole amounts · enter one value or a low–high range; leave maximum blank for one amount.', 'field-help')
      hint.id = id + '-range-help'
      for (const control of range.querySelectorAll('input')) control.setAttribute('aria-describedby', hint.id)
      wrap.append(heading, range, hint); return wrap
    }
    const control = node('input'); control.type = 'number'; control.step = '1'; control.inputMode = 'numeric'
    control.min = String(field.min ?? 0); control.max = String(field.max ?? 100000000)
    control.id = id; control.dataset.claim = field.name; control.autocomplete = 'off'
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
    const target = protocol?.protocols?.find(row => row.claim_kind === field.name)
    const lines = (protocol?.budget_lines ?? []).filter(row => row.claim_kinds.includes(field.name))
    const bounds = field.type === 'money' ? `0–${formatMoney(100000000, protocol?.pack.currency || 'SGD')} · whole amounts; single value or range`
      : field.type === 'integer' ? `${field.min ?? 0}–${field.max ?? 'no upper limit'}${field.unit ? ' ' + field.unit : ''} · whole numbers`
        : field.type === 'enum' ? field.values.map(enumLabel).join(' · ')
          : field.type === 'boolean' ? 'Yes · No' : field.type
    add('Parameter', field.label + (field.unit ? ' · ' + field.unit : ''))
    add('Input', field.type === 'money' ? `Amount · ${protocol?.pack.currency || 'SGD'}` : field.type === 'integer' ? `Whole number${field.unit ? ' · ' + field.unit : ''}` : field.type === 'enum' ? 'Choose one' : 'Yes or no')
    add('Completeness', field.required ? 'Required for a complete local check · blank stays unknown' : 'Optional pack field')
    add(field.type === 'enum' || field.type === 'boolean' ? 'Allowed values' : field.type === 'money' || field.type === 'integer' ? 'Entry limits' : 'Entry rule', bounds)
    if (lines.length) add('Budget use', lines.map(line => `${line.id} · ${line.label}${line.formula ? ` (${line.formula})` : ''}`).join(' · '))
    add('Evidence target', target ? `${target.tier} · ${target.provenance.replaceAll('_', ' ')}${target.effort_min ? ` · ${target.effort_min} min planned` : ''}` : field.retiring_tier ? `${field.retiring_tier} target · see the pack review note` : 'No evidence tier defined for this input')
    if (target) add('Next evidence check', target.task)
    return details
  }

  function renderEvidence(item, fields, protocol) {
    evidenceEditor.replaceChildren()
    const evidenceFields = fields.filter(field => field.retiring_tier)
    if (!evidenceFields.length) { evidenceEditor.append(node('p', 'No evidence tier is defined for this pack.', 'muted')); return }
    let selected = evidenceFields.find(field => field.name === getEvidenceField())
      ?? evidenceFields.find(field => field.name === 'price') ?? evidenceFields[0]
    setEvidenceField(selected.name)
    evidenceHeading.textContent = `Evidence for ${selected.label} · Set ${item.slot}`
    const claimWrap = node('section', undefined, 'field'), claimLabel = node('label', 'Evidence field'), claimSelect = node('select')
    claimSelect.id = 'sme-evidence-claim'; claimLabel.htmlFor = claimSelect.id
    for (const field of evidenceFields) option(claimSelect, field.name, field.label + (field.unit ? ' · ' + field.unit : ''))
    claimSelect.value = selected.name
    claimSelect.setAttribute('aria-label', 'Evidence field for Set ' + item.slot)
    claimSelect.addEventListener('change', () => { setEvidenceField(claimSelect.value); renderEvidence(item, fields, protocol) })
    claimWrap.append(claimLabel, claimSelect)

    const provenance = node('select'); provenance.id = 'sme-evidence-provenance'; option(provenance, '', 'Evidence source…')
    for (const row of [['seller_stated', 'Seller stated · T0'], ['buyer_assumed', 'Buyer assumed · T0'], ['observed_on_site', 'Observed on site · T1'], ['measured_on_foot', 'Measured on foot · T1'], ['counted_on_site', 'Counted on site · T1'], ['document_sighted', 'Document sighted · T2'], ['third_party_confirmed', 'Third party confirmed · T3']]) option(provenance, row[0], row[1])
    const role = node('select'); role.id = 'sme-evidence-role'; option(role, '', 'Observer role…')
    for (const name of ['buyer', 'adviser', 'field_checker']) option(role, name, name.replaceAll('_', ' '))
    const date = node('input'); date.type = 'date'; date.id = 'sme-evidence-date'
    const metadata = node('div', undefined, 'evidence-fields')
    for (const [control, labelText] of [[provenance, 'Provenance'], [role, 'Observer'], [date, 'Date']]) {
      const wrap = node('section', undefined, 'field'), label = node('label', labelText)
      label.htmlFor = control.id; wrap.append(label, control); metadata.append(wrap)
    }
    const valuePrefix = 'compare-evidence', valueControl = inputControl(selected, valuePrefix, protocol)
    const list = node('ul', undefined, 'sme-evidence-list'), add = node('button', 'Add evidence'); add.type = 'button'; add.id = 'sme-evidence-add'
    const renderRows = () => {
      list.replaceChildren()
      item.evidence.forEach((row, index) => {
        if (row.claim_kind !== selected.name) return
        const entry = node('li', `${formatClaim(selected, row.value)} · ${row.provenance.replaceAll('_', ' ')} · ${row.observer_role.replaceAll('_', ' ')} · ${row.date}`)
        const remove = node('button', 'Remove'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${selected.label} evidence`)
        remove.addEventListener('click', () => { item.evidence.splice(index, 1); invalidate(); render() })
        entry.append(remove); list.append(entry)
      })
    }
    add.addEventListener('click', () => {
      const value = readValue(selected, valuePrefix, evidenceEditor)
      if (value === undefined || !provenance.value || !role.value || !date.value || item.evidence.length >= 40) {
        workflowStatus.textContent = item.evidence.length >= 40 ? 'A set can include at most 40 evidence entries.'
          : 'Choose a value, provenance, observer and date before adding evidence.'; return
      }
      item.evidence.push({ claim_kind: selected.name, value, provenance: provenance.value, observer_role: role.value, date: date.value })
      invalidate(); render()
    })
    evidenceEditor.append(claimWrap, metadata, valueControl, add, list); renderRows()
  }

  function render() {
    const item = getSlots().find(row => row.slot === getSelectedSlot()), fields = getFields(), protocol = getProtocol()
    workflowEditor.hidden = !item
    claimInputs.replaceChildren(); evidenceEditor.replaceChildren()
    if (!item) return
    heading.textContent = `Edit · Set ${item.slot}`
    note.textContent = 'Edit every table field for this claim set. Blank stays unknown; values and sighted evidence stay in this tab and are not authenticated.'
    const fallback = fields.find(field => field.name === 'price') ?? fields[0]
    activeParameter = fields.some(field => field.name === activeParameter) ? activeParameter : fallback?.name ?? null
    showParameter = field => { activeParameter = field.name; parameterDetails.replaceChildren(guidance(field, protocol)) }
    if (fields.length) showParameter(fields.find(field => field.name === activeParameter) ?? fields[0])
    const fieldset = node('fieldset', undefined, 'workflow-edit-set'), grid = node('div', undefined, 'workflow-edit-fields')
    fieldset.append(node('legend', 'Set ' + item.slot), grid)
    const prefix = 'compare-' + item.slot.toLowerCase()
    for (const field of fields) {
      const control = inputControl(field, prefix, protocol)
      writeValue(field, prefix, item.claims[field.name], control)
      for (const input of control.querySelectorAll('input, select')) input.addEventListener(input instanceof HTMLSelectElement ? 'change' : 'input', () => {
        const value = readValue(field, prefix, control)
        if (value === undefined) delete item.claims[field.name]; else item.claims[field.name] = value
        invalidate()
      })
      grid.append(control)
    }
    claimInputs.append(fieldset)
    renderEvidence(item, fields, protocol)
  }

  return { render }
}
