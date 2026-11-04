const columns = [
  { id: 'record', name: 'Record' }, { id: 'key', name: 'Stable key' }, { id: 'label', name: 'Label' },
  { id: 'section', name: 'Section' }, { id: 'definition', name: 'Definition / use' }, { id: 'type', name: 'Type' },
  { id: 'required', name: 'Required' }, { id: 'unit', name: 'Unit' }, { id: 'constraints', name: 'Values / bounds' },
  { id: 'review', name: 'Evidence / status' }, { id: 'source', name: 'Formula / source' }, { id: 'owner', name: 'Canonical owner' },
]
const ownerRows = [
  ['Shared token', '/', 'Invocation grammar and command metadata', 'agentic-os/docs/INVOCATION.md · catalog/dictionaries/DICTIONARY-COMMAND.md'],
  ['Shared token', '#', 'Shared semantic dictionary; page fragments remain local routes', 'agentic-os/catalog/dictionaries/DICTIONARY-SEMANTIC.md'],
  ['Shared token', '@', 'Binding reference; no credentials or authority implied', 'agentic-os/catalog/dictionaries/DICTIONARY-BINDING.md'],
  ['Skill metadata', 'agent.sme-care', 'Provider-neutral source-grounded assistance metadata; not a plan executor', 'agentic-canvas-os/docs/SKILLS.md'],
  ['Tool discovery', 'MCP · WebMCP', 'Shared gateway contract; pack adapters expose the canonical tool schema', 'agentic-canvas-os/docs/MCP-GATEWAY.md · Commerce adapters'],
  ['Context schema', 'AgenticRAG', 'Shared JSON-LD context and invocation metadata terms', 'huijoohwee.github.io/schema/AgenticRAG/v1/context.jsonld'],
]
const display = value => {
  if (value === undefined || value === null || value === '') return 'Not declared.'
  if (Array.isArray(value) && value.length === 0 || typeof value === 'object' && Object.keys(value).length === 0) return 'None declared.'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 1000 ? text.slice(0, 997) + '…' : text
}

export function createSmePackDictionaryView(protocol, orientation = 'rows', onOrientationChange, toolSchemas = []) {
  if (!protocol?.pack || !Array.isArray(protocol.input_fields) || !Array.isArray(protocol.model_outputs)) throw Error('sme_dictionary_protocol_invalid')
  const rows = []
  const add = (record, key, label, section, definition, type, required, unit, constraints, review, source, owner) => rows.push({
    id: `${record.toLowerCase().replaceAll(' ', '-')}-${rows.length + 1}`,
    cells: [record, key, label, section, definition, type, required, unit, constraints, review, source, owner].map(display),
  })
  add('Plan contract', protocol.pack.id, protocol.pack.label, 'Identity',
    'Versioned, user-defined planning schema. No location, sector, benchmark, default, or currency is implied.', 'object', 'Yes', '',
    { version: protocol.pack.version, as_of: protocol.pack.as_of }, protocol.pack.review_status, protocol.schema, 'Active plan registry and protocol')
  add('Protocol schema', 'schema', protocol.schema, 'Identity', 'Versioned runtime data contract for inputs, model outputs, evidence guidance, and tools.',
    'schema identifier', 'Yes', '', '', 'Active', 'pack.protocol.schema', 'Plan protocol')
  for (const field of protocol.input_fields) add('Input field', field.name, field.label, field.section ?? 'Plan',
    field.definition ?? 'User-supplied planning input. Blank values remain unknown.', field.type, field.required ? 'Yes' : 'No', field.unit,
    { values: field.values, min: field.min, max: field.max, max_length: field.max_length, pattern: field.pattern },
    field.evidence_status ?? 'User-recorded; not authenticated', 'pack.protocol.input_fields', 'Active plan contract')
  for (const output of protocol.model_outputs) add('Model output', output.id, output.label, 'Financial model',
    'Deterministic arithmetic from supplied inputs; not a forecast or benchmark.', 'derived value', 'No', '', output.inputs,
    'Unknown when required inputs are missing', output.formula, 'Active plan contract')
  for (const artifact of protocol.artifacts ?? []) add('Plan artifact', artifact.id, artifact.label, 'Pitch',
    'Structured draft assembled only from declared inputs and deterministic model displays; missing narrative remains explicit.',
    artifact.format, 'No', 'slides', artifact.inputs, 'Draft · user review required', artifact.output, 'Active plan evaluator')
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
    ariaLabel: 'Business plan data dictionary; input, output, evidence, tool, and shared vocabulary records are rows and their definitions are columns.', onOrientationChange }
}
