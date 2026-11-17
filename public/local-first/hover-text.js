/** Shared hover help syntax. Products supply facts, labels and actions. */
export const HOVER_PARTS = Object.freeze({
    panel: 'agentic-hover-panel', label: 'agentic-hover-label', text: 'agentic-hover-text',
    key: 'agentic-hover-key', value: 'agentic-hover-value', expanded: 'agentic-hover-expanded-text',
});
export const HOVER_BEHAVIOR = Object.freeze({ scrollDelayMs: 500, scrollIntervalMs: 30, bridgeCloseDelayMs: 420 });
export const HOVER_DISMISS_EVENT = 'agentic-hover-dismiss';

export function computeTooltipPositionFromAnchor(anchor, offsetPx) {
    const rect = anchor.getBoundingClientRect();
    return { top: Math.round(rect.bottom + offsetPx), left: Math.round(rect.left + rect.width / 2) };
}
export function computeTooltipMaxWidthPx(anchor, { maxWidthFromPrevSibling, maxWidthPx, defaultMaxWidthPx }) {
    const width = maxWidthPx ?? (maxWidthFromPrevSibling ? anchor.previousElementSibling?.getBoundingClientRect().width : undefined) ?? defaultMaxWidthPx;
    if (!Number.isFinite(width) || width < 0) throw new TypeError('Invalid hover width');
    return Math.round(width);
}
/** Centered fixed-position geometry, including anchors at a viewport corner. */
export function constrainTooltipPosition({ pos, tooltipRect, anchorRect, viewportW, viewportH, paddingPx, offsetPx }) {
    if (![pos.left, pos.top, tooltipRect.width, tooltipRect.height, anchorRect.top, viewportW, viewportH, paddingPx, offsetPx].every(Number.isFinite)
        || viewportW <= 0 || viewportH <= 0 || tooltipRect.width < 0 || tooltipRect.height < 0 || paddingPx < 0)
        throw new TypeError('Invalid hover viewport geometry');
    const gap = Math.min(paddingPx, Math.max(0, (viewportW - 1) / 2));
    const minLeft = gap + tooltipRect.width / 2;
    const maxLeft = Math.max(minLeft, viewportW - gap - tooltipRect.width / 2);
    let top = pos.top;
    if (top + tooltipRect.height > viewportH - paddingPx) top = anchorRect.top - offsetPx - tooltipRect.height;
    top = Math.max(paddingPx, Math.min(top, Math.max(paddingPx, viewportH - paddingPx - tooltipRect.height)));
    return { left: Math.min(maxLeft, Math.max(minLeft, Math.round(pos.left))),
        top: Math.max(paddingPx, Math.min(Math.round(top), Math.max(paddingPx, viewportH - paddingPx - tooltipRect.height))) };
}
export function getTooltipPortalTarget(anchor) {
    const doc = anchor?.ownerDocument ?? globalThis.document;
    if (!doc?.body) throw new TypeError('Hover requires an owner document');
    return doc.fullscreenElement?.contains(anchor) ? doc.fullscreenElement : doc.body;
}
export function isTooltipRelatedTarget(value) {
    return Boolean(value?.ownerDocument?.defaultView?.Element && value instanceof value.ownerDocument.defaultView.Element
        && value.closest('[data-agentic-hover-root="1"]'));
}
export function formatHoverValue(value) {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'string' || typeof value === 'boolean') return String(value);
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
    const text = JSON.stringify(Array.isArray(value) ? value.slice(0, 3) : value);
    if (typeof text !== 'string') throw new TypeError('Hover value must be serializable');
    return text;
}
export function buildHoverKeyValueText(key, value) { return `${String(key)}: ${formatHoverValue(value)}`; }

export function buildNumericTooltip(options) {
    return buildBoundsImpactTooltip({
        defaultValue: options.defaultValue,
        min: options.min,
        max: options.max,
        interval: options.interval,
        impact: options.impact,
    });
}
export function buildRoleActionOutcomeTooltip(options) {
    const actionsPart = options.actions.join(' \u2192 ');
    return `${options.role} \u2192 ${actionsPart} \u2192 ${options.outcome}`;
}
function countWords(text) {
    const normalized = String(text || '').trim().replace(/\s+/g, ' ');
    if (!normalized)
        return 0;
    return normalized.split(' ').filter(Boolean).length;
}
function truncateWords(text, maxWords) {
    const normalized = String(text || '').trim().replace(/\s+/g, ' ');
    if (!normalized)
        return '';
    const words = normalized.split(' ');
    if (words.length <= maxWords)
        return normalized;
    return `${words.slice(0, Math.max(0, maxWords)).join(' ')}\u2026`;
}
function extractClampRangeFromNotes(notes) {
    const raw = String(notes || '');
    const m = raw.match(/clamps\s+to\s*\[\s*([0-9]*\.?[0-9]+)\s*,\s*([0-9]*\.?[0-9]+)\s*\]/i);
    if (!m)
        return {};
    const min = Number(m[1]);
    const max = Number(m[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max))
        return {};
    return { min, max };
}
function extractIntervalFromNotes(notes) {
    const raw = String(notes || '');
    const m = raw.match(/\b(?:interval|step)\s*(?:=|:)?\s*([0-9]*\.?[0-9]+)\b/i);
    if (!m)
        return undefined;
    const value = Number(m[1]);
    if (!Number.isFinite(value))
        return undefined;
    return value;
}
function toTooltipRole(area) {
    const raw = String(area || '').trim();
    if (!raw || raw === '\u2014')
        return 'Settings';
    return raw;
}
export function buildSettingsKeyTooltip(params) {
    const role = String(params.role || '').trim() || toTooltipRole(params.area);
    const actions = Array.isArray(params.actions) && params.actions.length > 0
        ? params.actions
        : [`edit ${params.key} in MainPanel → Settings`, 'apply changes via MainPanel header'];
    const tooltip = buildRoleActionOutcomeTooltip({
        role,
        actions,
        outcome: String(params.outcome || '').trim() || params.responsibility || 'update runtime behavior',
    });
    return truncateWords(tooltip, 50);
}
export function buildSettingsValueTooltip(params) {
    const defaultLabel = typeof params.defaultValueOverride !== 'undefined'
        ? String(params.defaultValueOverride ?? '—')
        : params.type === 'boolean'
            ? typeof params.defaultValue === 'boolean'
                ? String(params.defaultValue)
                : 'false'
            : typeof params.defaultValue === 'number' && Number.isFinite(params.defaultValue)
                ? String(params.defaultValue)
                : typeof params.defaultValue === 'string' && params.defaultValue.trim().length > 0
                    ? params.defaultValue.trim()
                    : '—';
    const noteBounds = extractClampRangeFromNotes(params.notes || '');
    const noteInterval = extractIntervalFromNotes(params.notes || '');
    const resolvedMin = typeof params.min !== 'undefined' ? params.min : noteBounds.min;
    const resolvedMax = typeof params.max !== 'undefined' ? params.max : noteBounds.max;
    const resolvedInterval = typeof params.interval !== 'undefined' ? params.interval : noteInterval;
    if (params.type === 'number' ||
        typeof resolvedMin !== 'undefined' ||
        typeof resolvedMax !== 'undefined' ||
        typeof resolvedInterval !== 'undefined' ||
        String(params.expansionNote || '').trim().length > 0 ||
        String(params.contractionNote || '').trim().length > 0) {
        return buildBoundsImpactTooltip({
            defaultValue: defaultLabel,
            min: resolvedMin,
            max: resolvedMax,
            interval: resolvedInterval,
            impact: params.impact,
            expansionNote: params.expansionNote,
            contractionNote: params.contractionNote,
        });
    }
    return [(`Default: ${defaultLabel}`), String(params.impact || '').trim()].filter(Boolean).join('; ');
}
export function buildDefaultTooltip(params) {
    const maxWords = 15;
    const def = typeof params.defaultValue === 'boolean'
        ? String(params.defaultValue)
        : typeof params.defaultValue === 'number' && Number.isFinite(params.defaultValue)
            ? String(params.defaultValue)
            : typeof params.defaultValue === 'string' && params.defaultValue.trim().length > 0
                ? params.defaultValue.trim()
                : '—';
    const base = `Default: ${def}`;
    const remaining = Math.max(0, maxWords - countWords(base));
    const impact = remaining > 0 ? truncateWords(String(params.impact || ''), remaining) : '';
    const final = [base, impact].filter(Boolean).join('; ');
    return truncateWords(final, maxWords);
}
function buildBoundsImpactTooltip(options) {
    const segments = [];
    segments.push(`Default: ${options.defaultValue}`);
    if (typeof options.min !== 'undefined') {
        segments.push(`Min: ${options.min}`);
    }
    if (typeof options.max !== 'undefined') {
        segments.push(`Max: ${options.max}`);
    }
    if (typeof options.interval !== 'undefined') {
        segments.push(`Interval: ${options.interval}`);
    }
    const { expansion, contraction, fallbackImpact } = splitImpactText(options.impact || '');
    const expansionText = String(options.expansionNote || expansion).trim();
    const contractionText = String(options.contractionNote || contraction).trim();
    if (expansionText)
        segments.push(expansionText);
    if (contractionText)
        segments.push(contractionText);
    if (!expansionText && !contractionText && fallbackImpact)
        segments.push(fallbackImpact);
    return segments.join('; ');
}
function splitImpactText(rawImpact) {
    const normalized = String(rawImpact || '').trim().replace(/\s+/g, ' ');
    if (!normalized) {
        return { expansion: '', contraction: '', fallbackImpact: '' };
    }
    const segments = normalized.split(';').map(part => part.trim()).filter(Boolean);
    if (segments.length >= 2) {
        return {
            expansion: segments[0],
            contraction: segments[1],
            fallbackImpact: normalized,
        };
    }
    return { expansion: '', contraction: '', fallbackImpact: normalized };
}
