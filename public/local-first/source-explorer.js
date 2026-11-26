export const SOURCE_FOLDER_ROOT_PATH = '';

export function normalizeSourceFolderPath(value) {
    return String(value || '').trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
}

export function resolveSourceParentFolderPath(path) {
    return normalizeSourceFolderPath(path).split('/').slice(0, -1).join('/');
}

export function expandSourceFolderAncestors({ expandedPaths, selectedFolderPath }) {
    const paths = new Set(expandedPaths).add('');
    let parent = '';
    for (const part of normalizeSourceFolderPath(selectedFolderPath).split('/').filter(Boolean)) {
        parent = parent ? parent + '/' + part : part;
        paths.add(parent);
    }
    return paths;
}

export function toggleSourceFolderPath(expandedPaths, path) {
    const result = new Set(expandedPaths);
    const key = normalizeSourceFolderPath(path);
    if (!result.delete(key)) result.add(key);
    return result.add('');
}

export function listPersistedSourceFolderPaths(paths) {
    return [...new Set(Array.from(paths, normalizeSourceFolderPath).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function buildSourceFileTree(items) {
    const root = { kind: 'folder', key: '', path: '', label: '', depth: 0, children: [] };
    const folders = new Map([['', root]]);
    for (const item of items || []) {
        const path = String(item?.name || '').trim().replaceAll('\\', '/').replace(/\/+$/g, '');
        const parts = path.split('/').filter(Boolean);
        if (!parts.length) continue;
        const label = parts.pop().trim() || path;
        let parent = root;
        for (const part of parts.map(name => name.trim()).filter(Boolean)) {
            const key = parent.path ? parent.path + '/' + part : part;
            if (!folders.has(key)) {
                const folder = { kind: 'folder', key: 'folder:' + key, path: key, label: part, depth: parent.depth + 1, children: [] };
                parent.children.push(folder);
                folders.set(key, folder);
            }
            parent = folders.get(key);
        }
        parent.children.push({ kind: 'file', key: 'file:' + (item.id || path), fileId: String(item.id || ''),
            label, path, depth: parts.length + 1, active: Boolean(item.active), versionCount: Math.max(0, Math.floor(Number(item.versionCount || 0))) });
    }
    return { root };
}

export function flattenVisibleSourceFileTree({ root, expandedPaths }) {
    const visible = [];
    const pending = [...(root.children || [])].reverse();
    while (pending.length) {
        const { children, ...node } = pending.pop();
        visible.push({ ...node, hasChildren: Boolean(children?.length) });
        if (children && expandedPaths.has(node.path)) pending.push(...[...children].reverse());
    }
    return visible;
}

const explorerState = new WeakMap();

// Native tree for model pages and source files. Products supply items and activation.
export function mountSourceExplorer(host, { items, label = 'Source files', selectedId, onOpen }) {
    const document = host.ownerDocument;
    let root = buildSourceFileTree(items).root;
    const prior = explorerState.get(host);
    const active = items.find(item => item.id === selectedId);
    let expandedPaths = expandSourceFolderAncestors({
        expandedPaths: prior?.expandedPaths || new Set(['']), selectedFolderPath: resolveSourceParentFolderPath(active?.name || '')
    });
    const tree = document.createElement('div');
    tree.className = 'agentic-source-explorer';
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', label);
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Filter pages and files';
    search.setAttribute('aria-label', search.placeholder);
    search.value = prior?.query || '';
    host.replaceChildren(search, tree);
    function filter() {
        const query = search.value.trim().toLocaleLowerCase();
        const matches = query ? items.filter(item => item.name.toLocaleLowerCase().includes(query)) : items;
        root = buildSourceFileTree(matches).root;
        if (query) for (const item of matches) {
            expandedPaths = expandSourceFolderAncestors({ expandedPaths, selectedFolderPath: resolveSourceParentFolderPath(item.name) });
        }
        render();
    }
    search.oninput = filter;
    let focusKey = active ? 'file:' + active.id : null;
    function render(moveFocus = false) {
        explorerState.set(host, { expandedPaths, query: search.value });
        const nodes = flattenVisibleSourceFileTree({ root, expandedPaths });
        if (!nodes.some(node => node.key === focusKey)) focusKey = nodes[0]?.key || null;
        const rows = nodes.map((node, index) => {
            const folder = node.kind === 'folder', open = expandedPaths.has(node.path);
            const row = document.createElement('button');
            row.type = 'button';
            row.setAttribute('role', 'treeitem');
            row.setAttribute('aria-level', String(node.depth));
            row.textContent = (folder ? (open ? '▾ ' : '▸ ') : '') + node.label;
            row.style.paddingInlineStart = (node.depth * 0.8) + 'em';
            if (folder) row.setAttribute('aria-expanded', String(open));
            else row.setAttribute('aria-selected', String(selectedId === node.fileId));
            row.tabIndex = focusKey === node.key || (!focusKey && !index) ? 0 : -1;
            const focusAt = i => {
                if (!nodes[i]) return;
                focusKey = nodes[i].key;
                rows.forEach((button, j) => { button.tabIndex = i === j ? 0 : -1; });
                rows[i].focus();
            };
            const toggle = () => {
                expandedPaths = toggleSourceFolderPath(expandedPaths, node.path);
                focusKey = node.key;
                render(true);
            };
            row.onclick = () => {
                if (folder) return toggle();
                selectedId = node.fileId;
                focusAt(index);
                rows.forEach(button => {
                    if (button.hasAttribute('aria-selected')) button.setAttribute('aria-selected', String(button === row));
                });
                onOpen(node.fileId);
            };
            row.onkeydown = event => {
                const key = event.key;
                if (!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(key)) return;
                event.preventDefault();
                if (key === 'Home' || key === 'End') return focusAt(key === 'Home' ? 0 : nodes.length - 1);
                if (key === 'ArrowDown' || key === 'ArrowUp') return focusAt(index + (key === 'ArrowDown' ? 1 : -1));
                if (folder && ((key === 'ArrowLeft') === open)) return toggle();
                if (key === 'ArrowRight') { if (folder && open) focusAt(index + 1); return; }
                focusAt(nodes.findIndex(n => n.kind === 'folder' && n.path === resolveSourceParentFolderPath(node.path)));
            };
            return row;
        });
        tree.replaceChildren(...rows);
        if (moveFocus) rows.find(button => button.tabIndex === 0)?.focus();
    }
    filter();
}

/** Two signed extents on the same scale, with a common zero at the midpoint. */
export function createVarianceBar(document, low, high, scale, label) {
    if (![low, high, scale].every(Number.isFinite) || scale <= 0 || Math.max(Math.abs(low), Math.abs(high)) > scale)
        throw new RangeError('Invalid variance bar domain');
    const chart = document.createElement('span');
    chart.className = 'agentic-variance-bar';
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', label);
    for (const extent of [Math.max(0, -low, -high), Math.max(0, low, high)]) {
        const bar = document.createElement('progress');
        bar.max = scale;
        bar.value = extent;
        bar.setAttribute('aria-hidden', 'true');
        chart.append(bar);
    }
    return chart;
}
