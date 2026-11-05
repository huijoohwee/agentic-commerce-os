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
      required_modes: field.required_modes, required_when: field.required_when },
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
    column.kind, 'No', column.facet, '', 'Derived from the active plan protocol', `pack.protocol.workflow_columns.${column.id}`, 'Active plan protocol')
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
  return { columns, rows, layout: 'multiDimensional', orientation,
    ariaLabel: 'SME plan data dictionary; input, output, evidence, tool, and shared vocabulary records are rows and their definitions are columns.', onOrientationChange }
}
