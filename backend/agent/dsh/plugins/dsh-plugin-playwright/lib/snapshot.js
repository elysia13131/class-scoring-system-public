/**
 * Accessibility snapshot builder for dsh-plugin-playwright.
 *
 * Uses Playwright's `locator.ariaSnapshot({ ref: true })` to obtain the
 * accessibility tree of the current page, parses the resulting YAML into a
 * JSON tree, and records a ref → locator map so action tools (`browser_click`,
 * `browser_type`, …) can target elements by the numeric refs the model saw in
 * the snapshot.
 *
 * @module dsh-plugin-playwright/snapshot
 */
import jsYaml from 'js-yaml';
const { load: parseYaml } = jsYaml;
/** Latest snapshot ref map per page, so action tools resolve `ref` args. */
const pageRefs = new WeakMap();
/** Latest snapshot ref map per iframe document (frame-piercing snapshots). */
const frameRefs = new WeakMap();
/**
 * Retrieve the ref map captured by the most recent snapshot of `owner`, where
 * `owner` is a page (main frame) or a frame object obtained via `resolveFrame`.
 */
export function refsFor(owner) {
    return pageRefs.get(owner) ?? frameRefs.get(owner);
}
/** Store the ref map for an owner page/frame (called by snapshotOf). */
export function storeRefs(owner, refs) {
    if (typeof owner.mainFrame === 'function')
        pageRefs.set(owner, refs);
    else
        frameRefs.set(owner, refs);
}
/** Roles we can map back to a locator via `getByRole`. */
const RESOLVABLE_ROLES = new Set([
    'link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
    'switch', 'slider', 'spinbutton', 'listbox', 'option', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'heading', 'img',
    'paragraph', 'list', 'listitem', 'table', 'row', 'cell', 'columnheader',
    'rowheader', 'grid', 'gridcell', 'tablist', 'tabpanel', 'dialog', 'alert',
    'status', 'log', 'timer', 'progressbar', 'tooltip', 'region', 'navigation',
    'banner', 'main', 'contentinfo', 'form', 'toolbar', 'menu', 'menubar',
    'tree', 'document', 'generic', 'separator', 'meter', 'article', 'figure',
    'group', 'note', 'strong', 'emphasis', 'caption', 'code', 'definition',
    'listmarker', 'math', 'subscript', 'superscript', 'time', 'insertion',
    'deletion', 'blockquote',
]);
/** Roles a model is allowed to point at for interaction tools. */
const INTERACTIVE_ROLES = new Set([
    'link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
    'switch', 'slider', 'spinbutton', 'listbox', 'option', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'textbox',
]);
function parseScalar(text) {
    // ariaSnapshot roles are alphanumeric (`link`, `generic`, `/url`, …); a
    // node that carries children is emitted as a YAML OBJECT whose key is the
    // same scalar descriptor, so this parser serves leaf scalars and object
    // keys alike. Keep a non-matching role verbatim (e.g. `/url` for hrefs).
    const roleMatch = /^([A-Za-z][\w-]*)/.exec(text);
    const role = roleMatch ? roleMatch[1] : text.trim() || 'generic';
    const nameMatch = /"((?:[^"\\]|\\.)*)"/.exec(text);
    const name = nameMatch
        ? nameMatch[1].replace(/\\(["\\])/g, '$1')
        : undefined;
    const attrs = {};
    const attrRe = /\[([^\]]+)\]/g;
    let match;
    while ((match = attrRe.exec(text)) !== null) {
        for (const part of match[1].split(',')) {
            const kv = /^\s*([\w-]+)\s*=\s*(.*)$/.exec(part);
            if (!kv)
                continue;
            let value = kv[2].trim().replace(/^"(.*)"$/, '$1');
            if (value === 'true')
                value = true;
            else if (value === 'false')
                value = false;
            else if (/^-?\d+$/.test(String(value)))
                value = Number(value);
            attrs[kv[1]] = value;
        }
    }
    return { role, name, attrs };
}
/** Convert parsed ariaSnapshot YAML into {@link SnapshotNode} children. */
function walkYaml(entry, out, refAllocator) {
    if (typeof entry === 'string') {
        const scalar = parseScalar(entry);
        const node = buildNode(scalar, refAllocator);
        out.push(node);
        return;
    }
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        for (const [key, value] of Object.entries(entry)) {
            // A node with children is an object key carrying the same scalar
            // descriptor as a leaf (`link "Docs" [ref=P0]:`); parse it so roles,
            // names, and refs are uniform across the tree.
            const node = buildNode(parseScalar(key), refAllocator);
            if (Array.isArray(value)) {
                const childNodes = [];
                walkYaml(value, childNodes, refAllocator);
                if (childNodes.length > 0)
                    node.children = childNodes;
            }
            else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                // ariaSnapshot emits an element's text content as the object key's
                // scalar value (`- paragraph [ref=e1]: 视频标题`); surface it as the
                // node's name so the model can read titles and text.
                const text = String(value);
                if (node.name === undefined)
                    node.name = text;
                else
                    node.value = text;
            }
            out.push(node);
        }
        return;
    }
    if (Array.isArray(entry)) {
        for (const child of entry)
            walkYaml(child, out, refAllocator);
    }
}
function buildNode(scalar, refAllocator) {
    // Only assign defined fields: the harness rejects tool values containing
    // `undefined`-valued keys ("value is not lossless JSON").
    const node = { role: scalar.role };
    if (scalar.name !== undefined)
        node.name = scalar.name;
    if (scalar.attrs.ref !== undefined && RESOLVABLE_ROLES.has(scalar.role)) {
        node.ref = refAllocator();
    }
    if (typeof scalar.attrs.value === 'string')
        node.value = scalar.attrs.value;
    if (typeof scalar.attrs.level === 'number')
        node.level = scalar.attrs.level;
    if (typeof scalar.attrs.checked === 'boolean')
        node.checked = scalar.attrs.checked;
    if (scalar.attrs.checked === 'mixed')
        node.checked = 'mixed';
    if (typeof scalar.attrs.pressed === 'boolean')
        node.pressed = scalar.attrs.pressed;
    if (typeof scalar.attrs.expanded === 'boolean')
        node.expanded = scalar.attrs.expanded;
    if (typeof scalar.attrs.disabled === 'boolean')
        node.disabled = scalar.attrs.disabled;
    if (typeof scalar.attrs.focused === 'boolean')
        node.focused = scalar.attrs.focused;
    if (typeof scalar.attrs.selected === 'boolean')
        node.selected = scalar.attrs.selected;
    if (typeof scalar.attrs.multiline === 'boolean')
        node.multiline = scalar.attrs.multiline;
    return node;
}
/**
 * Take an accessibility snapshot of `page` and build the ref → locator map.
 *
 * Ref numbering is sequential in DFS order over the tree; the numeric refs are
 * what action tools resolve `ref` arguments against. The ref map is stored so
 * action tools can target elements named in the latest snapshot.
 */
export async function takeAccessibilitySnapshot(page) {
    const snapshot = await snapshotOf(page);
    return {
        snapshot: { page: { url: page.url(), title: await page.title() }, snapshot },
        refs: pageRefs.get(page),
    };
}
/**
 * Frame-piercing sibling of {@link takeAccessibilitySnapshot}: snapshot the
 * accessibility tree of one iframe document (`frame` from `resolveFrame`).
 * Refs produced here are stored against the frame, and interact tools resolve
 * them when the same `frame`/`frameIndex` argument is passed alongside `ref`.
 * This is how a model sees and operates inside a cross-origin login iframe.
 */
export async function takeFrameAccessibilitySnapshot(frame) {
    const snapshot = await snapshotOf(frame);
    return {
        snapshot: { page: { url: frame.url(), title: frame.name() }, snapshot },
        refs: frameRefs.get(frame),
    };
}
async function snapshotOf(owner) {
    const yaml = await owner.locator(':root').ariaSnapshot({ mode: 'ai' });
    const parsed = parseYaml(yaml);
    const children = [];
    let refCounter = 0;
    walkYaml(parsed, children, () => ++refCounter);
    // The document root. ariaSnapshot of :root may already yield a single
    // RootWebArea node; otherwise wrap the parsed children.
    const isPage = typeof owner.mainFrame === 'function';
    let snapshot;
    if (children.length === 1 && children[0].role === 'RootWebArea' && children[0].children) {
        snapshot = children[0];
    }
    else {
        const root = { role: 'RootWebArea', children };
        if (isPage)
            root.name = await owner.title();
        snapshot = root;
    }
    const refs = await buildRefMap(owner, snapshot);
    (isPage ? pageRefs : frameRefs).set(owner, refs);
    return snapshot;
}
/** Map every ref in the tree to a Playwright locator. */
async function buildRefMap(owner, root) {
    const refs = new Map();
    // `getByRole(role)` matches EVERY element with that role (named or not), so
    // a nameless node's nth index must count all same-role nodes. A named node
    // uses `getByRole(role, { name })`, which matches only same-name elements,
    // so its nth index counts same (role, name) nodes.
    const roleCounts = new Map();
    const namedCounts = new Map();
    const visit = (node) => {
        const roleIndex = roleCounts.get(node.role) ?? 0;
        roleCounts.set(node.role, roleIndex + 1);
        if (node.ref !== undefined) {
            if (node.name !== undefined) {
                const nameKey = `${node.role}\u0000${node.name}`;
                const nameIndex = namedCounts.get(nameKey) ?? 0;
                namedCounts.set(nameKey, nameIndex + 1);
                const locator = owner.getByRole(node.role, { name: node.name, exact: true }).nth(nameIndex);
                refs.set(node.ref, locator);
            }
            else {
                const locator = owner.getByRole(node.role).nth(roleIndex);
                refs.set(node.ref, locator);
            }
        }
        for (const child of node.children ?? [])
            visit(child);
    };
    visit(root);
    return refs;
}
/** Whether a ref-carrying role is a sensible interaction target. */
export function isInteractiveRole(role) {
    return INTERACTIVE_ROLES.has(role);
}
