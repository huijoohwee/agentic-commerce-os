
export function nestSmePackTableRows({ rows, pathFor, createGroupRow }) {
  if (!Array.isArray(rows) || typeof pathFor !== 'function' || typeof createGroupRow !== 'function')
    throw Error('sme_table_hierarchy_arguments_invalid')
  const root = { children: new Map(), rows: [] }
  for (const row of rows) {
    const path = pathFor(row).map(value => String(value ?? '').trim()).filter(Boolean)
    let node = root
    for (const label of path) {
      if (!node.children.has(label)) node.children.set(label, { children: new Map(), rows: [] })
      node = node.children.get(label)
    }
    node.rows.push(row)
  }
  const output = []
  const visit = (node, path, depth) => {
    for (const [label, child] of node.children) {
      const nextPath = [...path, label]
      output.push({ ...createGroupRow({ path: nextPath, depth }), depth })
      visit(child, nextPath, depth + 1)
    }
    output.push(...node.rows.map(row => ({ ...row, depth })))
  }
  visit(root, [], 1)
  return output
}

const columns = [
  { id: 'record', name: 'Record' }, { id: 'key', name: 'Stable key' }, { id: 'label', name: 'Label' },
  { id: 'section', name: 'Section' }, { id: 'definition', name: 'Definition / use' }, { id: 'type', name: 'Type' },
  { id: 'required', name: 'Required' }, { id: 'unit', name: 'Unit' }, { id: 'constraints', name: 'Values / bounds' },
  { id: 'review', name: 'Evidence / status' }, { id: 'source', name: 'Formula / source' }, { id: 'owner', name: 'Canonical owner' },
]
const ownerRows = [
  ['Shared token', '/', 'Reference implementation owner for invocation grammar and command metadata', 'agentic-os/docs/INVOCATION.md · catalog/dictionaries/DICTIONARY-COMMAND.md'],
  ['Shared token', '#', 'Reference implementation owner for shared semantic terms; page fragments remain local routes', 'agentic-os/catalog/dictionaries/DICTIONARY-SEMANTIC.md'],
  ['Shared token', '@', 'Reference implementation owner for binding references; no credentials or authority implied', 'agentic-os/catalog/dictionaries/DICTIONARY-BINDING.md'],
  ['Skill metadata', 'agent.sme-care', 'Reference implementation for provider-neutral source-grounded assistance metadata; not a plan executor', 'agentic-canvas-os/docs/SKILLS.md'],
  ['Tool discovery', 'MCP · WebMCP', 'Reference implementation for the shared gateway; pack adapters expose the canonical tool schema', 'agentic-canvas-os/docs/MCP-GATEWAY.md · Commerce adapters'],
  ['Context schema', 'AgenticRAG', 'Reference implementation for shared JSON-LD context and invocation metadata terms', 'huijoohwee.github.io/schema/AgenticRAG/v1/context.jsonld'],
]
const display = value => {
  if (value === undefined || value === null || value === '') return 'Not declared.'
  if (Array.isArray(value) && value.length === 0 || typeof value === 'object' && Object.keys(value).length === 0) return 'None declared.'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 1000 ? text.slice(0, 997) + '…' : text
}
const dictionaryGroups = rows => {
  const pathFor = row => {
    const [record, , , section] = row.cells
    if (record === 'Input field') return ['Inputs', section || 'Plan']
    if (['Plan contract', 'Calculation model', 'Illustrative input set', 'Protocol schema', 'Workflow mode'].includes(record)) return ['Contract', 'Identity and modes']
    if (record === 'Model output') return ['Plan outputs', 'Model calculations']
    if (record === 'Coverage output') return ['Plan outputs', 'Coverage']
    if (record === 'Workflow column') return row.cells[1].startsWith('review-') ? ['Review workflow', 'Shared parameters'] : ['Plan outputs', 'Readiness and evidence']
    if (record === 'Review step' || record === 'View-note exchange') return ['Review workflow', 'Field references and exchange']
    if (record === 'Plan artifact') return ['Projection outline', 'Artifacts']
    if (record === 'Pitch role column') return ['Projection outline', 'Role columns']
    if (record === 'Guideline source') return ['Canonical owners', 'Guideline sources']
    if (record === 'Shared requirement') return ['Canonical owners', 'Shared requirements']
    if (record === 'Projection contract' || record === 'Projection requirement') return ['Canonical owners', section || 'Projection requirements']
    if (['Calculation parameter', 'Evidence guidance', 'Tolerance', 'Ratio'].includes(record)) return ['Protocol collections', record]
    if (record === 'Review metadata' || record === 'Invocation metadata') return ['Protocol metadata', record]
    if (record === 'Tool schema') return ['Invocation surfaces', 'Tool schemas']
    if (record === 'Shared token' || record === 'Skill metadata') return ['Shared vocabulary', 'Owner references']
    return ['Protocol records', section || record]
  }
  return nestSmePackTableRows({ rows, pathFor, createGroupRow: ({ path, depth }) => {
    const label = path.at(-1), key = `group:${path.join('.')}`
    const id = `group-${path.map(part => part.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')).join('--')}`
    return { id, depth, cells: ['Hierarchy group', key, label, path.slice(0, -1).join(' › '),
      'Display grouping derived from the active protocol. This row is not an input, output, evidence claim, or rule.',
      'group label', 'No', '', '', 'Display structure only', 'pack.protocol', 'Base Multi-dimensional Table'] }
  } })
}

export function createSmePackDictionaryView(protocol, orientation = 'rows', onOrientationChange, toolSchemas = []) {
  if (!protocol?.pack || protocol.schema !== 'sme-business-plan/protocol/v3' || !Array.isArray(protocol.plan_modes) || !Array.isArray(protocol.input_fields)
    || !Array.isArray(protocol.model_outputs) || !Array.isArray(protocol.coverage_outputs) || !Array.isArray(protocol.workflow_columns) || !Array.isArray(protocol.guideline_sources)
    || protocol.guideline_alignment?.schema !== 'sme-business-plan/guideline-alignment/v1'
    || !Array.isArray(protocol.guideline_alignment.shared_requirements)
    || !Array.isArray(protocol.guideline_alignment.projections)) throw Error('sme_dictionary_protocol_invalid')
  const rows = []
  const add = (record, key, label, section, definition, type, required, unit, constraints, review, source, owner) => rows.push({
    id: `${record.toLowerCase().replaceAll(' ', '-')}-${rows.length + 1}`,
    cells: [record, key, label, section, definition, type, required, unit, constraints, review, source, owner].map(display),
  })
  const guidelineById = Object.fromEntries(protocol.guideline_sources.map(source => [source.id, source]))
  add('Plan contract', protocol.pack.id, protocol.pack.label, 'Identity',
    'Versioned, user-defined planning schema. No unselected location, sector, benchmark, default, or currency is implied.', 'object', 'Yes', '',
    { version: protocol.pack.version, as_of: protocol.pack.as_of }, protocol.pack.review_status, protocol.schema, 'Active plan registry and protocol')
  add('Calculation model', 'calculation_model', protocol.calculation_model, 'Model',
    'Contract-owned deterministic evaluator using only declared inputs; no quality, suitability, or market judgment.',
    'model identifier', 'Yes', '', protocol.model_outputs.map(row => row.id), 'Active', 'pack.protocol.calculation_model', 'Shared local evaluator')
  add('Illustrative input set', 'illustrative_inputs', 'User-loaded example', 'Examples',
    'Loaded only after an explicit user action. These values are examples, are never defaults, and remain in tab memory.',
    'input bundle', 'No', '', Object.keys(protocol.illustrative_inputs ?? {}), 'Explicit action required',
    'pack.protocol.illustrative_inputs', 'Active plan contract')
  add('Protocol schema', 'schema', protocol.schema, 'Identity', 'Versioned runtime data contract for inputs, model outputs, evidence guidance, and tools.',
    'schema identifier', 'Yes', '', '', 'Active', 'pack.protocol.schema', 'Plan protocol')
  for (const mode of protocol.plan_modes) add('Workflow mode', mode.id, mode.label, 'E2E workflow', mode.description,
    'workspace mode', mode.default ? 'Default' : 'Selectable', 'Rows', mode.row_label, 'One shared table and evaluator', 'pack.protocol.plan_modes', 'Active plan protocol')
  for (const field of protocol.input_fields) add('Input field', field.name, field.label, field.section ?? 'Plan',
    field.definition ?? 'User-supplied planning input. Blank values remain unknown.', field.type,
    field.required ? 'Yes' : field.required_modes?.length || field.required_when ? 'Conditional' : 'No', field.unit,
    { values: field.values, min: field.min, max: field.max, max_length: field.max_length, pattern: field.pattern,
      required_modes: field.required_modes, required_when: field.required_when, review_step: field.review_step },
    field.evidence_status ?? 'User-recorded; not authenticated', 'pack.protocol.input_fields', 'Active plan contract')
  for (const output of protocol.model_outputs) add('Model output', output.id, output.label, 'Financial model',
    'Deterministic arithmetic from supplied inputs; not a forecast or benchmark.', 'derived value', 'No', '', output.inputs,
    'Unknown when required inputs are missing', output.formula, 'Active plan contract')
  for (const output of protocol.coverage_outputs) {
    const projection = protocol.guideline_alignment.projections.find(row => row.id === output.projection_id)
    const owner = output.kind === 'projection' ? guidelineById[projection?.source_id] : null
    add('Coverage output', output.id, output.label, 'Workflow coverage', output.definition, 'derived coverage', 'No', '',
      output.projection_id ?? protocol.protocols.map(row => row.field_key), 'Coverage only · not a quality or conformance decision',
      owner ? `${owner.path}@${owner.version}` : 'pack.protocol.protocols', owner?.path ?? 'Active plan evidence guidance')
  }
  for (const column of protocol.workflow_columns) add('Workflow column', column.id, column.label, 'E2E workflow', column.definition,
    column.type ?? column.kind, 'No', column.unit ?? column.facet, { pattern: column.pattern, writable: column.writable, cardinality: column.cardinality }, 'Derived from the active plan protocol', `pack.protocol.workflow_columns.${column.id}`, 'Active plan protocol')
  if (protocol.review_workflow) add('Review metadata', 'review_workflow', 'Review outline', 'E2E workflow', protocol.review_workflow.description,
    'view guidance', 'No', '', protocol.review_workflow.schema, 'No standard duration, mandatory sequence or completion forecast', 'pack.protocol.review_workflow', 'Active plan protocol')
  for (const step of protocol.review_workflow?.steps ?? []) add('Review step', step.id, step.title, 'E2E workflow', step.guidance,
    'field grouping', 'No', '', { order: 'Suggested; revisitable', focus_field: step.focus_field, input_fields: protocol.input_fields.filter(field => field.review_step === step.id).map(field => field.name) },
    'Same Plan options schema; no separate field definitions', 'pack.protocol.review_workflow.steps', 'Active plan protocol')
  if (protocol.review_workflow) add('View-note exchange', protocol.review_workflow.exchange.schema, 'Optional review timing', 'E2E workflow',
    'Local view notes keyed by canonical workflow fields; financial worksheet inputs are never imported from this file.', 'JSON', 'No', '', protocol.review_workflow.exchange,
    'Explicit local import/export; dates optional', 'pack.protocol.review_workflow.exchange', 'Active plan protocol')
  for (const artifact of protocol.artifacts ?? []) {
    add('Plan artifact', artifact.id, artifact.label, 'Pitch',
      'Structured draft assembled only from declared inputs and deterministic model displays; missing narrative remains explicit.',
      artifact.format, 'No', 'slides', artifact.inputs, 'Draft · user review required', artifact.output, 'Active plan evaluator')
    for (const role of artifact.roles ?? []) add('Pitch role column', `${artifact.id}.${role.id}`, role.label, 'Pitch',
      'One protocol-defined pitch outline field; shown as its own column in the shared workflow table.', 'derived text', 'No', '',
      { slide: role.slide, input_fields: role.input_fields, model_output_keys: role.model_output_keys ?? [] },
      'Draft · user review required', `${artifact.id}.roles`, 'Active plan protocol')
  }
  for (const source of protocol.guideline_sources) add('Guideline source', source.id, source.title, 'Canonical owner',
    'Read-only owner reference. This schema records the source revision and anchor without copying its taxonomy or rules.',
    'reference', 'Yes', '', { version: source.version, anchors: source.anchors }, 'Canonical · referenced, not redefined', source.path, source.path)
  for (const requirement of protocol.guideline_alignment.shared_requirements) {
    const owner = guidelineById[requirement.source_id]
    if (!owner) throw Error('sme_dictionary_guideline_owner_missing')
    add('Shared requirement', requirement.key, requirement.label, 'Parent alignment',
      'Canonical parent requirement; this record reports product support without redefining the owner’s rule.', 'guideline reference',
      'For full contract', '', requirement.input_fields, `MVP status: ${requirement.status}`,
      `${owner.path}@${owner.version}#${requirement.anchor}`, owner.path)
  }
  for (const projection of protocol.guideline_alignment.projections) {
    const owner = guidelineById[projection.source_id]
    if (!owner) throw Error('sme_dictionary_guideline_owner_missing')
    add('Projection contract', projection.id, projection.label, 'Audience projection',
      `Consumes the joined artifact; current product scope is ${projection.support_status}.`, 'projection reference',
      'For full contract', '', { artifact_id: projection.artifact_id, join_rule: protocol.guideline_alignment.join_rule },
      `MVP scope: ${projection.support_status}`, `${owner.path}@${owner.version}`, owner.path)
    for (const requirement of projection.requirements ?? []) {
      const requirementOwner = guidelineById[requirement.source_id ?? projection.source_id]
      if (!requirementOwner) throw Error('sme_dictionary_guideline_owner_missing')
      add('Projection requirement', `${projection.id}.${requirement.key}`, requirement.label, projection.label,
        'Canonical requirement owned by the referenced guideline. The product exposes mapped input keys and reports support status; it does not create a parallel owner contract.',
        'guideline reference', 'For full contract', '', requirement.input_fields,
        `MVP status: ${requirement.status}`, `${requirementOwner.path}@${requirementOwner.version}#${requirement.anchor}`, requirementOwner.path)
    }
  }
  const collections = [
    ['Calculation parameter', 'parameters', item => [item.id ?? item.name, item.label ?? item.name, 'Financial model', 'Pack-declared calculation metadata, separate from user input.', item.type, 'No', item.unit, item.values ?? item.value, item.review_status ?? item.reviewed, item.formula ?? item.source, 'Active plan contract']],
    ['Evidence guidance', 'protocols', item => [item.field_key, item.field_key, 'Evidence', item.task, 'guidance', 'No', '', 'User-recorded context', 'Not authenticated', '', 'Active plan contract']],
    ['Tolerance', 'tolerances', item => [item.id ?? item.name, item.label ?? item.name, 'Comparison', 'Explicit comparison tolerance, if declared.', item.type, 'No', item.unit, item.value ?? item.bounds, item.reviewed, item.basis, 'Active plan contract']],
    ['Ratio', 'ratios', item => [item.id ?? item.name, item.label ?? item.name, 'Financial model', 'Pack-declared ratio, if any.', item.type, 'No', item.unit, item.value ?? item.bounds, item.reviewed, item.formula ?? item.source, 'Active plan contract']],
  ]
  for (const [record, key, project] of collections) {
    const values = protocol[key] ?? []
    if (!values.length) add(record, key, 'None declared', 'Plan contract', 'No entries are declared by the active schema.', 'collection', 'No', '', '', '', `pack.protocol.${key}`, 'Active plan contract')
    for (const item of values) add(record, ...project(item))
  }
  add('Review metadata', 'review_note', 'Plan contract note', 'Governance', protocol.review_note, 'text', 'No', '', '', protocol.pack.review_status, 'pack.protocol.review_note', 'Active plan contract')
  add('Invocation metadata', 'inference_tokens', 'Inference tokens', 'Governance', 'Deterministic tool execution count.', 'integer', 'Yes', 'tokens', protocol.inference_tokens, protocol.pack.review_status, 'pack.protocol.inference_tokens', 'Active plan contract')
  for (const tool of toolSchemas) add('Tool schema', tool.name, tool.name, 'MCP · WebMCP',
    'Canonical bounded schema shared by explicit MCP and optional WebMCP calls.', 'JSON Schema', 'No', '',
    { required: tool.inputSchema?.required ?? [], parameters: Object.keys(tool.inputSchema?.properties ?? {}) },
    tool.annotations, 'TOOL_SCHEMAS', 'Shared pack core and local adapters')
  for (const [record, key, definition, owner] of ownerRows) add(record, key, key, 'Shared vocabulary',
    `${definition}. This row points to its canonical owner and does not redefine shared semantics.`, 'reference', 'No', '', '', '', 'Canonical source reference', owner)
  const nestedRows = dictionaryGroups(rows)
  return { columns, rows: nestedRows, layout: 'multiDimensional', orientation,
    ariaLabel: 'SME plan data dictionary; protocol records are nested by contract, section, output, and canonical owner, with definitions and owners as columns.', onOrientationChange }
}

// The same field records and metadata columns back Plan options, Review steps and Gantt.
export function createSmeWorkflowFieldView({ protocol, slots, dimensions, resultSlots, format, requirement, enumLabel, rowLabel, review = false, onActivateField }) {
  const names = ['Record type', 'Section', 'Group', 'Parameter', 'Stable key', 'Data type', 'Unit', 'Requirement', 'Allowed values', 'Minimum', 'Maximum', 'Length limit', 'Pattern', 'Definition']
  const columns = [...names.map((name, index) => ({ id: `metadata-${index}`, name })), ...slots.map(item => ({ id: `value-${item.slot}`, name: rowLabel(item.slot) }))]
  const record = (id, cells) => ({ id, cells: cells.map(value => value == null ? 'Not declared' : String(value)) })
  const inputs = new Map(protocol.input_fields.map(field => [field.name, field]))
  const inputRows = protocol.input_fields.map(field => record(`input:${field.name}`, ['Input', field.section ?? 'Not declared', 'Input', field.label, field.name, field.type,
    field.unit, requirement(field), field.values?.map(enumLabel).join(', '), field.min, field.max, field.max_length, field.pattern, field.definition,
    ...slots.map(item => format(field, item.inputs[field.name], item.inputs.currency_code))]))
  const outputRows = dimensions.map(dimension => {
    const parts = dimension.name.split(' › '), parameter = parts.pop().replace(/\s+\[[^\]]+\]$/u, ''), field = dimension.field ?? {}
    const section = dimension.section ?? parts[0] ?? 'Workflow', group = dimension.group ?? (parts.slice(1).join(' › ') || 'Not declared')
    const kind = field.kind === 'review_view' ? 'Review parameter' : section === 'Plan' ? 'Plan state' : section === 'Readiness' ? 'Readiness' : section === 'Evidence' ? 'Evidence' : `${section} output`
    return record(`output:${dimension.id}`, [kind, section, group, dimension.parameter ?? parameter, dimension.id, field.type ?? 'Derived', field.unit,
      field.kind === 'review_view' ? field.writable ? 'Optional view note' : 'Protocol-derived' : 'Calculated or reported', field.values?.map(enumLabel).join(', '),
      field.min, field.max, field.max_length, field.pattern, field.definition, ...slots.map(item => dimension.read(resultSlots.find(slot => slot.slot === item.slot)))])
  })
  const steps = new Map((protocol.review_workflow?.steps ?? []).map(step => [step.id, step.title]))
  const rows = nestSmePackTableRows({ rows: [...inputRows, ...outputRows], pathFor: row => {
    const [kind, section, group, , key] = row.cells
    if (review && kind === 'Input') return [steps.get(inputs.get(key).review_step), section]
    if (review && kind === 'Review parameter') return ['Review parameters']
    const path = [kind, section, group === 'Input' ? '' : group]
    return path.filter((value, index) => value && value !== path[index - 1])
  }, createGroupRow: ({ path }) => {
    const slug = path.map(part => part.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')).join('--')
    return record(`group:${slug}`, ['Hierarchy group', path[1] ?? 'Workflow', path[2] ?? 'Workflow records', path.at(-1), `group:${slug}`,
      'group label', 'Not applicable', 'No', 'Not applicable', 'Not applicable', 'Not applicable', 'Not applicable', 'Not applicable',
      'Display grouping derived from the active contract; not an input, output, evidence claim or rule.', ...slots.map(() => 'Not applicable')])
  } })
  return { columns, rows, layout: 'multiDimensional', orientation: 'rows', ariaLabel: review
    ? 'Review steps grouped from the same Plan options fields, values and parameter definitions.' : 'Workflow fields and outputs with shared metadata and plan option values.',
    onActivateRow: id => { const [kind, ...parts] = id.split(':'); if (kind === 'input' || kind === 'output') onActivateField?.(parts.join(':')) } }
}
