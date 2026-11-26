import { CONTRACT, LIMITS, STARTER_GRID, SheetsError, byteLength, coordinate, addressOf, requireValue } from './schema.mjs';
class FormulaError extends Error { constructor(code) { super(code); this.code = code; } }
const problem = code => { throw new FormulaError(code); };
const errors = { PARSE: '#PARSE!', REFERENCE: '#REF!', VALUE: '#VALUE!', DIV_ZERO: '#DIV/0!', CYCLE: '#CYCLE!', NUMBER: '#NUM!' };
const sumName = 'SUM';
const range = Object.freeze({ name: 'start:end', kind: 'range', description: 'One rectangular range, from its upper-left to lower-right cell.' });
const sum = Object.freeze({
  id: 'math.sum', name: sumName, binding: CONTRACT, signature: `${sumName}(${range.name})`,
  arguments: Object.freeze([range]), summary: 'Adds the numbers in the range. Empty cells count as zero.',
  example: Object.freeze({ cells: Object.freeze({ A1: 2, A2: 3 }), formula: `=${sumName}(A1:A2)`, result: 5 }),
});
const installedFunctions = Object.freeze([sum]);
export function listFunctions() { return installedFunctions; }

// Keep the recognized name in the lexer identical to the installed workbook binding.
const cellToken = String.raw`\$?[A-Z]+\$?[0-9]+`;
const isCell = new RegExp(`^${cellToken}$`);
const addressToken = token => typeof token === 'string' && isCell.test(token) ? token.replaceAll('$', '') : null;
const nextToken = new RegExp(String.raw`^(?:\d+\.?\d*|\.\d+)(?:E[+-]?\d+)?|^${cellToken}|^${sum.name}\b|^[+*/():,-]`, 'i');
function scan(source, visit, draft = false) {
  const text = source;
  for (let offset = 1; offset < text.length;) {
    if (/\s/.test(text[offset])) { offset++; continue; }
    const match = nextToken.exec(text.slice(offset));
    if (!match) return draft && /^\$?[A-Z]*\$?$/i.test(text.slice(offset));
    offset += match[0].length;
    visit(match[0].toUpperCase(), offset);
  }
  return true;
}
function rectangle(start, end, bounds) {
  const a = coordinate(addressToken(start), bounds), b = coordinate(addressToken(end), bounds), addresses = [];
  if (b.row < a.row || b.column < a.column) return addresses;
  requireValue((b.row - a.row + 1) * (b.column - a.column + 1) <= LIMITS.edges, 'LIMIT', 'Range exceeds the dependency budget');
  for (let row = a.row; row <= b.row; row++) {
    for (let column = a.column; column <= b.column; column++) addresses.push(addressOf(row, column));
  }
  return addresses;
}
// Inspect bounded, potentially incomplete editor text without reading or changing a workbook.
export function inspectFormulaDraft(source, caret = source?.length, bounds = STARTER_GRID) {
  const empty = { references: [], functionName: null };
  if (typeof source !== 'string' || !source.startsWith('=') || source.length > LIMITS.formulaBytes
      || byteLength(source) > LIMITS.formulaBytes) return empty;
  const tokens = [], calls = [];
  let previous = '';
  const recognized = scan(source, (token, end) => {
    if (end <= caret) {
      if (token === '(') calls.push(previous === sum.name ? previous : null);
      if (token === ')') calls.pop();
    }
    tokens.push(token);
    previous = token;
  }, true);
  if (!recognized || tokens.length > LIMITS.tokens) return empty;
  const references = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const start = tokens[i];
    if (!isCell.test(start)) continue;
    const hasEnd = tokens[i + 1] === ':' && tokens[i + 2] !== undefined;
    const end = hasEnd ? tokens[i + 2] : start;
    if (hasEnd) i += 2;
    const label = hasEnd ? start + ':' + end : start;
    if (references.has(label)) continue;
    try {
      const addresses = rectangle(start, end, bounds);
      if (addresses.length) references.set(label, { label, addresses });
    } catch (failure) {
      if (!(failure instanceof SheetsError) || !['REFERENCE', 'LIMIT'].includes(failure.code)) throw failure;
    }
  }
  return { references: [...references.values()], functionName: calls.includes(sum.name) ? sum.name : null };
}
export function compileFormula(source, bounds = STARTER_GRID) {
  const tokens = [], ends = [], dependencies = new Set(), references = [];
  requireValue(typeof source === 'string' && source.startsWith('='), 'INVALID_CELL', 'Formula must begin with =');
  requireValue(byteLength(source) <= LIMITS.formulaBytes, 'LIMIT', 'Cell exceeds byte limit');
  let index = 0;
  if (!scan(source, (token, end) => {
    tokens.push(token); ends.push(end);
    requireValue(tokens.length <= LIMITS.tokens, 'LIMIT', 'Formula token limit exceeded');
  })) problem('PARSE');
  const ref = address => {
    dependencies.add(address);
    return { kind: 'ref', address };
  };
  function reference(first, last) {
    const start = ends[first] - tokens[first].length, end = ends[last];
    let addresses;
    try { addresses = rectangle(tokens[first], tokens[last], bounds); }
    catch (error) { if (error.code === 'REFERENCE') problem('REFERENCE'); throw error; }
    if (!addresses.length) problem('REFERENCE');
    references.push({ kind: first === last ? 'cell' : 'range', text: source.slice(start, end), start, end, addresses });
    return addresses;
  }
  const take = token => { if (tokens[index++] !== token) problem('PARSE'); };
  function atom(depth) {
    requireValue(depth <= LIMITS.depth, 'LIMIT', 'Formula nesting limit exceeded');
    const token = tokens[index++];
    if (token === '(') { const node = expression(depth + 1); take(')'); return node; }
    if (token === sum.name) {
      take('(');
      const first = index++;
      if (!isCell.test(tokens[first])) problem('REFERENCE');
      take(':');
      const last = index++;
      if (!isCell.test(tokens[last])) problem('REFERENCE');
      take(')');
      const addresses = reference(first, last);
      // Preserve the public dependency order for existing workbooks.
      dependencies.add(addresses[0]);
      dependencies.add(addresses.at(-1));
      return { kind: 'sum', items: addresses.map(ref) };
    }
    if (isCell.test(token)) return ref(reference(index - 1, index - 1)[0]);
    if (token && /^(?:\d|\.)/.test(token)) {
      const value = Number(token); if (!Number.isFinite(value)) problem('NUMBER');
      return { kind: 'number', value };
    }
    problem('PARSE');
  }
  function unary(depth) {
    requireValue(depth <= LIMITS.depth, 'LIMIT', 'Formula nesting limit exceeded');
    if (tokens[index] === '+' || tokens[index] === '-') return { kind: 'unary', op: tokens[index++], node: unary(depth + 1) };
    return atom(depth);
  }
  function term(depth) {
    let left = unary(depth);
    while (tokens[index] === '*' || tokens[index] === '/') left = { kind: 'binary', op: tokens[index++], left, right: unary(depth) };
    return left;
  }
  function expression(depth) {
    let left = term(depth);
    while (tokens[index] === '+' || tokens[index] === '-') left = { kind: 'binary', op: tokens[index++], left, right: term(depth) };
    return left;
  }
  const node = expression(0);
  if (index !== tokens.length) problem('PARSE');
  return { node, dependencies, references };
}

/** Accepted formula occurrences in source order, with zero-based UTF-16 spans. */
export function extractFormulaReferences(source, bounds = STARTER_GRID) {
  return compileFormula(source, bounds).references;
}
export function calculate(workbook, visitDependencies) {
  const compiled = new Map(), results = {}, visiting = new Set();
  let edges = 0, steps = 0;
  for (const [address, cell] of Object.entries(workbook.cells)) {
    if (cell.type !== 'formula') continue;
    try {
      const code = compileFormula(cell.value, workbook); compiled.set(address, code);
      edges += code.dependencies.size;
      requireValue(edges <= LIMITS.edges, 'LIMIT', 'Workbook dependency limit exceeded');
    } catch (error) {
      if (error instanceof SheetsError) throw error;
      if (!(error instanceof FormulaError)) throw error;
      compiled.set(address, { error: error.code });
    }
  }
  const step = () => requireValue(++steps <= LIMITS.steps, 'LIMIT', 'Calculation operation limit exceeded');
  function numeric(address) {
    const result = cellResult(address);
    if (result.error) problem(result.error);
    if (result.value === null) return 0;
    if (typeof result.value !== 'number') problem('VALUE');
    return result.value;
  }
  function evaluate(node) {
    step();
    if (node.kind === 'number') return node.value;
    if (node.kind === 'ref') return numeric(node.address);
    if (node.kind === 'unary') return node.op === '-' ? -evaluate(node.node) : evaluate(node.node);
    if (node.kind === 'sum') return node.items.reduce((sum, item) => sum + evaluate(item), 0);
    const left = evaluate(node.left), right = evaluate(node.right);
    if (node.op === '/' && right === 0) problem('DIV_ZERO');
    return node.op === '+' ? left + right : node.op === '-' ? left - right : node.op === '*' ? left * right : left / right;
  }
  function cellResult(address) {
    if (Object.hasOwn(results, address)) return results[address];
    if (visiting.has(address)) problem('CYCLE');
    const cell = workbook.cells[address];
    if (!cell || cell.type !== 'formula') return { value: cell?.value ?? null };
    visiting.add(address);
    let result;
    try {
      const code = compiled.get(address);
      if (code.error) problem(code.error);
      const value = evaluate(code.node);
      if (!Number.isFinite(value)) problem('NUMBER');
      result = { value };
    } catch (error) {
      if (!(error instanceof FormulaError)) throw error;
      result = { value: null, error: error.code, display: errors[error.code] };
    } finally { visiting.delete(address); }
    results[address] = result;
    return result;
  }
  for (const address of Object.keys(workbook.cells).sort()) results[address] = cellResult(address);
  if (visitDependencies) {
    for (const [address, code] of compiled) {
      if (code.dependencies) visitDependencies(address, code.dependencies);
    }
  }
  return results;
}
