// IDs belong to the source collections. Preserve case, punctuation and Unicode exactly.
function identifier(value) {
  if (typeof value !== 'string' || !value.length || /[\uD800-\uDFFF]/u.test(value)) {
    throw new TypeError('Expected a nonempty Unicode record identifier.');
  }
  return value;
}

function endpointIndex(ids) {
  const index = new Map();
  for (const id of ids) {
    if (index.has(identifier(id))) throw new TypeError('Duplicate record identifier.');
    index.set(id, []);
  }
  return index;
}

function lookup(index, id) {
  const edges = index.get(id);
  if (!edges) throw new RangeError('Unknown relationship endpoint.');
  return edges;
}

/** Project one immutable many-to-many relation over two explicitly supplied collections. */
export function createRecordRelation({ sources, targets, links }) {
  const outgoing = endpointIndex(sources), incoming = endpointIndex(targets), seen = new Set();
  for (const { source, target, label } of links) {
    const from = lookup(outgoing, source), to = lookup(incoming, target);
    if (label !== undefined && typeof label !== 'string') throw new TypeError('Expected a text link label.');
    const identity = JSON.stringify([source, target, label]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const edge = Object.freeze(label === undefined ? { source, target } : { source, target, label });
    from.push(edge);
    to.push(edge);
  }
  for (const index of [outgoing, incoming]) for (const edges of index.values()) Object.freeze(edges);
  return Object.freeze({ from: source => lookup(outgoing, source), to: target => lookup(incoming, target) });
}

/** Encode and resolve same-document bookmarks using the host's view and parameter names. */
export function createRecordLinkCodec({ fragment, views }) {
  if (/[#?\s]/u.test(identifier(fragment))) throw new TypeError('Invalid record link fragment.');
  const prefix = '#' + encodeURIComponent(fragment) + '?', names = new Map(), params = new Map();
  for (const { view, record = view, group } of views) {
    if (names.has(identifier(view))) throw new TypeError('Duplicate record view.');
    const fields = { record: identifier(record) };
    if (group !== undefined) fields.group = identifier(group);
    for (const [key, name] of Object.entries(fields)) {
      if (params.has(name)) throw new TypeError('Ambiguous record link parameter.');
      params.set(name, { view, key });
    }
    names.set(view, fields);
  }
  function href({ view, record, group }) {
    const namesForView = names.get(view);
    if (!namesForView || (group !== undefined && !namesForView.group) || (record === undefined && group === undefined)) {
      throw new TypeError('Invalid record link destination.');
    }
    const search = new URLSearchParams();
    if (group !== undefined) search.set(namesForView.group, identifier(group));
    if (record !== undefined) search.set(namesForView.record, identifier(record));
    return prefix + search;
  }
  function parse(hash) {
    if (typeof hash !== 'string' || !hash.startsWith(prefix)) return null;
    let destination;
    const query = hash.slice(prefix.length);
    // URLSearchParams replaces invalid UTF-8 with U+FFFD. A malformed bookmark must not open a different record.
    try { decodeURIComponent(query); } catch { return null; }
    for (const [name, value] of new URLSearchParams(query)) {
      const field = params.get(name);
      if (!field || !value || (destination && (destination.view !== field.view || Object.hasOwn(destination, field.key)))) return null;
      destination ??= { view: field.view };
      destination[field.key] = value;
    }
    return destination ?? null;
  }
  return Object.freeze({ href, parse });
}
