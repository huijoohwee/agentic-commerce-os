const columns = [
  { id: 'record', name: 'Record' }, { id: 'key', name: 'Stable key' },
  { id: 'label', name: 'Label' }, { id: 'definition', name: 'Definition / use' },
  { id: 'type', name: 'Type' }, { id: 'required', name: 'Required' },
  { id: 'unit', name: 'Unit' }, { id: 'constraints', name: 'Values / bounds' },
  { id: 'review', name: 'Evidence / review' }, { id: 'source', name: 'Formula / source' },
  { id: 'owner', name: 'Canonical owner' },
]
const ownerRows = [
  ['Shared token', '/', 'Invocation syntax and command metadata', 'agentic-os/docs/INVOCATION.md · catalog/dictionaries/DICTIONARY-COMMAND.md'],
  ['Shared token', '#', 'Semantic token dictionary; URL fragments remain Commerce routes', 'agentic-os/catalog/dictionaries/DICTIONARY-SEMANTIC.md'],
  ['Shared token', '@', 'Binding token dictionary; no credentials or authority implied', 'agentic-os/catalog/dictionaries/DICTIONARY-BINDING.md'],
  ['Skill metadata', 'agent.sme-care', 'Existing provider-neutral skill metadata; no pack-local skill alias', 'agentic-canvas-os/docs/SKILLS.md'],
  ['Tool discovery', 'MCP · WebMCP', 'Shared gateway metadata; this pack exposes its declared tool schemas', 'agentic-canvas-os/docs/MCP-GATEWAY.md · Commerce adapters'],
  ['Context schema', 'AgenticRAG', 'Shared JSON-LD context and invocation metadata terms', 'huijoohwee.github.io/schema/AgenticRAG/v1/context.jsonld'],
]
const display = value => {
  if (value === undefined || value === null || value === '') return 'Not declared.'
  if (Array.isArray(value) && value.length === 0 || typeof value === 'object' && Object.keys(value).length === 0) return 'None declared.'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 1000 ? text.slice(0, 997) + '…' : text
}

export function createSmePackDictionaryView(protocol, orientation = 'rows', onOrientationChange, toolSchemas = []) {
  if (!protocol?.pack || !Array.isArray(protocol.claim_kinds)) throw Error('sme_dictionary_protocol_invalid')
  const rows = []
  const add = (record, key, label, definition, type, required, unit, constraints, review, source, owner) => rows.push({
    id: `${record.toLowerCase().replaceAll(' ', '-')}-${rows.length + 1}`,
    cells: [record, key, label, definition, type, required, unit, constraints, review, source, owner].map(display),
  })
  add('Pack', protocol.pack.id, protocol.pack.id, 'Versioned pack identity and review context.', 'object', 'Yes', protocol.pack.currency,
    { country: protocol.pack.country, asset_type: protocol.pack.asset_type, version: protocol.pack.version, as_of: protocol.pack.as_of },
    protocol.pack.review_status, protocol.schema, 'Active pack registry and protocol')
  add('Protocol schema', 'schema', protocol.schema, 'Versioned data contract for the active pack.', 'schema identifier', 'Yes', '', '', '', 'pack.protocol.schema', 'Pack protocol')
  for (const [index, field] of protocol.claim_kinds.entries()) add('Input field', field.name, field.label,
    'Buyer-entered value validated by the active pack contract.', field.type, field.required ? 'Yes' : 'No', field.unit,
    { values: field.values, min: field.min, max: field.max }, field.retiring_tier, 'pack.protocol.claim_kinds', field.owner ?? 'Active pack contract')
  const collections = [
    ['Budget line', 'budget_lines', item => [item.id, item.label, 'Pack-declared output from input fields.', 'derived value', 'No', '', item.claim_kinds, item.retiring_tier, item.formula, 'Active pack contract']],
    ['Parameter', 'parameters', item => [item.id ?? item.name, item.label ?? item.name, 'Pack-declared calculation metadata; separate from buyer input.', item.type, 'No', item.unit, item.values ?? item.value, item.review_status ?? item.reviewed, item.formula ?? item.source, 'Active pack contract']],
    ['Ratio', 'ratios', item => [item.id, item.id, 'Pack-declared arithmetic relation; not a benchmark.', 'ratio', 'No', '', `${item.numerator} / ${item.denominator}`, `reviewed: ${Boolean(item.reviewed)}`, item.basis, 'Active pack contract']],
    ['Evidence protocol', 'protocols', item => [item.claim_kind, item.claim_kind, item.task, 'evidence task', 'No', item.effort_minutes ? `${item.effort_minutes} min` : '', item.provenance, item.tier ?? item.retiring_tier, '', 'Active pack contract']],
    ['Tolerance', 'tolerances', item => [item.id ?? item.name, item.label ?? item.name, 'Explicit comparison tolerance, if declared.', item.type, 'No', item.unit, item.value ?? item.bounds, item.reviewed, item.basis, 'Active pack contract']],
  ]
  for (const [record, key, project] of collections) {
    const values = protocol[key] ?? []
    if (!values.length) add(record, key, 'None declared', 'No entries declared by the active pack.', 'collection', 'No', '', '', '', `pack.protocol.${key}`, 'Active pack contract')
    for (const item of values) add(record, ...project(item))
  }
  add('Review metadata', 'review_note', 'Pack review note', protocol.review_note, 'text', 'No', '', '', protocol.pack.review_status, 'pack.protocol.review_note', 'Active pack contract')
  add('Invocation metadata', 'inference_tokens', 'Inference tokens', 'Deterministic pack contract value.', 'integer', 'Yes', 'tokens', protocol.inference_tokens, protocol.pack.review_status, 'pack.protocol.inference_tokens', 'Active pack contract')
  for (const tool of toolSchemas) add('Tool schema', tool.name, tool.name,
    'Canonical bounded tool schema shared by explicit MCP and optional WebMCP calls.', 'JSON Schema', 'No', '',
    { required: tool.inputSchema?.required ?? [], parameters: Object.keys(tool.inputSchema?.properties ?? {}) },
    tool.annotations, 'TOOL_SCHEMAS', 'sme-business-pack-core.js and local adapters')
  for (const [record, key, definition, owner] of ownerRows) add(record, key, key,
    `${definition}. This row references its owner and does not redefine shared semantics.`, 'reference', 'No', '', '', '', 'Canonical source reference', owner)
  return { columns, rows, layout: 'multiDimensional', orientation, ariaLabel: 'SME pack data dictionary; protocol and canonical reference records are rows and definitions are columns.', onOrientationChange }
}
