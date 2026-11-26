export const CONTRACT = 'sheets/workbook/v1';
export const STARTER_GRID = Object.freeze({ rows: 32, columns: 16 });
export const LIMITS = Object.freeze({ rows: 512, columns: 128, gridCells: 4096, populatedCells: 512, formulas: 64, textBytes: 1024,
  formulaBytes: 256, bytes: 262144, tokens: 128, depth: 16, edges: 512, steps: 4096, operations: 64 });
export class SheetsError extends Error {
  constructor(code, message) { super(message); this.name = 'SheetsError'; this.code = code; }
}
export function requireValue(condition, code, message) { if (!condition) throw new SheetsError(code, message); }
export const byteLength = text => new TextEncoder().encode(text).length;
export function record(value, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'INVALID', `${label} must be an object`);
  return value;
}
export function keys(value, allowed, required = allowed) {
  record(value, 'Value');
  requireValue(Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)),
    'INVALID', 'Unexpected or missing property');
}
export function identifier(value) {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value), 'INVALID_ID', 'Invalid identity');
  return value;
}
export function fitsGrid(rows, columns) {
  return Number.isSafeInteger(rows) && rows > 0 && rows <= LIMITS.rows
    && Number.isSafeInteger(columns) && columns > 0 && columns <= LIMITS.columns
    && rows * columns <= LIMITS.gridCells;
}
export function coordinate(address, bounds = LIMITS) {
  const match = typeof address === 'string' && /^([A-Z]{1,2})([1-9][0-9]{0,2})$/.exec(address);
  requireValue(match, 'REFERENCE', 'Invalid worksheet address');
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  requireValue(row <= bounds.rows && column <= bounds.columns, 'REFERENCE', 'Address outside worksheet bounds');
  return { row: row - 1, column: column - 1 };
}
export function columnLabel(index) {
  requireValue(Number.isInteger(index) && index >= 0 && index < LIMITS.columns, 'REFERENCE', 'Invalid column index');
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    label = String.fromCharCode(65 + (n - 1) % 26) + label;
  }
  return label;
}
export const addressOf = (row, column) => columnLabel(column) + (row + 1);
export function canonical(value) {
  let nodes = 0, bytes = 0;
  const charge = count => { bytes += count; requireValue(bytes <= LIMITS.bytes, 'LIMIT', 'Snapshot or command exceeds 256 KiB'); };
  const visit = (item, depth = 0) => {
    requireValue(++nodes <= 8192 && depth <= 16, 'LIMIT', 'JSON structure exceeds the limit');
    if (item === null || typeof item === 'boolean') { charge(5); return item; }
    if (typeof item === 'string') { requireValue(item.length <= LIMITS.bytes, 'LIMIT', 'String exceeds byte limit'); charge(byteLength(item) + 2); return item; }
    if (typeof item === 'number') { requireValue(Number.isFinite(item), 'INVALID', 'Numbers must be finite'); charge(String(item).length); return item; }
    if (Array.isArray(item)) { charge(item.length + 2); return item.map(entry => visit(entry, depth + 1)); }
    record(item, 'JSON value');
    requireValue(Object.getOwnPropertySymbols(item).length === 0, 'INVALID', 'Symbols are not JSON');
    charge(2);
    return Object.fromEntries(Object.keys(item).sort().map(key => { charge(byteLength(key) + 4); return [key, visit(item[key], depth + 1)]; }));
  };
  const text = JSON.stringify(visit(value));
  requireValue(byteLength(text) <= LIMITS.bytes, 'LIMIT', 'Snapshot or command exceeds 256 KiB');
  return text;
}
export function validateCell(cell) {
  keys(cell, ['type', 'value']);
  const { type, value } = cell;
  requireValue(['text', 'number', 'boolean', 'formula'].includes(type), 'INVALID_CELL', 'Unsupported cell type');
  if (type === 'number') requireValue(typeof value === 'number' && Number.isFinite(value), 'INVALID_CELL', 'Number must be finite');
  else if (type === 'boolean') requireValue(typeof value === 'boolean', 'INVALID_CELL', 'Boolean value required');
  else {
    requireValue(typeof value === 'string', 'INVALID_CELL', 'Text required');
    requireValue(byteLength(value) <= (type === 'formula' ? LIMITS.formulaBytes : LIMITS.textBytes), 'LIMIT', 'Cell exceeds byte limit');
    if (type === 'formula') requireValue(value.startsWith('='), 'INVALID_CELL', 'Formula must begin with =');
  }
  return { type, value };
}
function origin(value) {
  keys(value, ['workbookId', 'sheetId', 'revision']);
  identifier(value.workbookId); identifier(value.sheetId);
  requireValue(Number.isSafeInteger(value.revision) && value.revision > 0, 'INVALID_REVISION', 'Invalid source revision');
}
export function validateWorkbook(input) {
  keys(input, ['contract', 'schemaVersion', 'workbookId', 'sheetId', 'name', 'revision', 'rows', 'columns', 'cells', 'operations', 'provenance'],
    ['contract', 'schemaVersion', 'workbookId', 'sheetId', 'name', 'revision', 'rows', 'columns', 'cells', 'operations']);
  requireValue(input.contract === CONTRACT && input.schemaVersion === 1, 'VERSION', 'Unsupported workbook version');
  identifier(input.workbookId); identifier(input.sheetId);
  requireValue(typeof input.name === 'string' && input.name.trim() && byteLength(input.name) <= 80, 'INVALID', 'Workbook name must contain 1–80 bytes');
  requireValue(Number.isSafeInteger(input.revision) && input.revision >= 1, 'INVALID_REVISION', 'Invalid workbook revision');
  requireValue(fitsGrid(input.rows, input.columns), 'LIMIT', 'Workbook dimensions exceed the local grid limit');
  record(input.cells, 'Cells');
  requireValue(Object.keys(input.cells).length <= LIMITS.populatedCells, 'LIMIT', 'Cell limit exceeded');
  let formulas = 0;
  for (const [address, cell] of Object.entries(input.cells)) {
    coordinate(address, input); validateCell(cell);
    if (cell.type === 'formula') formulas++;
  }
  requireValue(formulas <= LIMITS.formulas, 'LIMIT', 'Formula cell limit exceeded');
  requireValue(Array.isArray(input.operations) && input.operations.length <= LIMITS.operations, 'LIMIT', 'Operation log exceeds limit');
  const ids = new Set();
  for (const op of input.operations) {
    keys(op, ['operationId', 'fingerprint', 'workbookId', 'revision']);
    identifier(op.operationId); identifier(op.workbookId);
    requireValue(!ids.has(op.operationId) && /^[a-f0-9]{64}$/.test(op.fingerprint)
      && Number.isSafeInteger(op.revision) && op.revision > 0, 'INVALID', 'Invalid operation receipt');
    ids.add(op.operationId);
  }
  if (input.provenance !== undefined) origin(input.provenance);
  return JSON.parse(canonical(input));
}
export function decodeSnapshot(text) {
  requireValue(typeof text === 'string' && byteLength(text) <= LIMITS.bytes, 'LIMIT', 'Snapshot exceeds 256 KiB');
  let data;
  try { data = JSON.parse(text); } catch { throw new SheetsError('INVALID', 'Snapshot is not valid JSON'); }
  return validateWorkbook(data);
}
export function parseInput(text) {
  if (text === '') return null;
  if (text.startsWith("'")) return validateCell({ type: 'text', value: text.slice(1) });
  if (text.startsWith('=')) return validateCell({ type: 'formula', value: text });
  if (/^(true|false)$/i.test(text)) return { type: 'boolean', value: text.toLowerCase() === 'true' };
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return validateCell({ type: 'number', value: Number(text) });
  return validateCell({ type: 'text', value: text });
}
export function inputOf(cell) {
  if (!cell) return '';
  if (cell.type === 'text') return cell.value === '' || /^[=']|^(?:true|false)$|^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(cell.value) ? `'${cell.value}` : cell.value;
  return String(cell.value);
}
