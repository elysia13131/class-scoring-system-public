/**
 * Inspection behaviour — reading the page's current state back to the model.
 *
 * These tools are read-only observations: the accessibility tree, captured
 * console messages, and captured network traffic. They are the plugin's "eyes",
 * in contrast to the `interact` tools that change the page.
 *
 * Fork additions:
 * - `browser_snapshot` accepts `frame`/`frameIndex` to snapshot one iframe
 *   document (a cross-origin login iframe is otherwise invisible);
 * - `browser_frame_list` enumerates every frame of the active page;
 * - `browser_element_box` returns an element's viewport bounding box (center
 *   coordinates in the same space as screenshots / `browser_click_at`).
 *
 * @module dsh-plugin-playwright/tools/inspect
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { takeAccessibilitySnapshot, takeFrameAccessibilitySnapshot } from '../snapshot.js';
import { frameTarget, refOrSelector } from './schema.js';
import { renderStateText, resolveFrame, resolveLocator, textBlock } from './util.js';
/** Build every inspection tool for one plugin instance. */
export function createInspectionTools(session, config) {
    const tools = [];
    tools.push(defineTool({
        name: 'browser_snapshot',
        description: 'Return the accessibility snapshot with numeric refs for interactive elements. Call this to perceive the page before acting. Main-frame snapshots do NOT include cross-origin iframe content — to read an embedded iframe (e.g. a login dialog), pass frame/frameIndex (discover them with browser_frame_list).',
        parameters: { ...frameTarget },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    url: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    snapshot: { type: 'json', required: true },
                },
            },
            render: (_args, value) => textBlock(renderStateText(value)),
        },
        execute: async ({ frame, frameIndex }, _exec) => session.run(async (handle) => {
            const page = handle.activePage();
            const target = resolveFrame(page, { frame, frameIndex });
            if (target === undefined) {
                const { snapshot } = await takeAccessibilitySnapshot(page);
                return { ok: true, url: page.url(), title: await page.title(), snapshot: snapshot.snapshot };
            }
            const { snapshot } = await takeFrameAccessibilitySnapshot(target);
            return { ok: true, url: target.url(), title: target.name() ?? '', snapshot: snapshot.snapshot };
        }),
    }));
    tools.push(defineTool({
        name: 'browser_frame_list',
        description: 'List every frame of the active page with its index, url and name. Use the index or a url substring as frame/frameIndex on browser_snapshot and the interact tools to operate inside iframes (e.g. cross-origin login dialogs).',
        parameters: {},
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    url: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    frames: { type: 'array', items: { type: 'json' }, required: true },
                },
            },
            render: (_args, value) => {
                const rows = value.frames.map((frame) => `${frame.index}${frame.main ? ' [main]' : ''} ${frame.url || '(no url)'}${frame.name ? ` name="${frame.name}"` : ''}`);
                return textBlock(`url: ${value.url}\ntitle: ${value.title}\nframes:\n${rows.join('\n') || '(none)'}`);
            },
        },
        execute: async (_args, _exec) => session.run(async (handle) => {
            const page = handle.activePage();
            const frames = page.frames().map((frame, index) => ({
                index,
                main: frame === page.mainFrame(),
                url: frame.url() || '',
                name: frame.name() ?? '',
            }));
            return { ok: true, url: page.url(), title: await page.title(), frames };
        }),
    }));
    tools.push(defineTool({
        name: 'browser_element_box',
        description: 'Return an element\'s viewport bounding box in CSS pixels: coordinates of its top-left corner, size, and center. Use the center coordinates with browser_click_at when ref/selector clicks fail (cross-origin iframe targets, canvases, obscured elements). Coordinates are relative to the viewport — the same space as browser_screenshot.',
        parameters: { ...refOrSelector },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    url: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    frame: { type: 'string' },
                    box: { type: 'json' },
                    viewport: { type: 'json' },
                },
            },
            render: (_args, value) => {
                if (value.box === null) {
                    return textBlock(`url: ${value.url}\ntitle: ${value.title}\nbox: element not visible (no bounding box)`);
                }
                const frameLine = value.frame ? `frame: ${value.frame}` : 'frame: (main)';
                return textBlock(`url: ${value.url}\ntitle: ${value.title}\n${frameLine}\nbox: x=${value.box.x} y=${value.box.y} ${value.box.width}x${value.box.height}\ncenter: (${value.box.centerX}, ${value.box.centerY})`);
            },
        },
        execute: async ({ ref, selector, frame, frameIndex }, exec) => session.run(async (handle) => {
            const page = handle.activePage();
            const locator = resolveLocator(handle, { ref, selector, frame, frameIndex });
            const box = await abortable(exec, locator.boundingBox({ timeout: 5000 })).catch(() => null);
            const viewport = page.viewportSize();
            const target = resolveFrame(page, { frame, frameIndex });
            return {
                ok: true,
                url: page.url(),
                title: await page.title(),
                frame: target === undefined ? null : target.url(),
                box: box === null
                    ? null
                    : {
                        x: box.x,
                        y: box.y,
                        width: box.width,
                        height: box.height,
                        centerX: box.x + box.width / 2,
                        centerY: box.y + box.height / 2,
                    },
                viewport: viewport === null ? null : { width: viewport.width, height: viewport.height },
            };
        }),
    }));
    tools.push(defineTool({
        name: 'browser_console_messages',
        description: 'Return console messages captured from the browser context (capped ring buffer).',
        parameters: {},
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    messages: { type: 'array', items: { type: 'json' }, required: true },
                },
            },
            render: (_args, value) => {
                const messages = value.messages;
                const rows = messages.length === 0
                    ? '(no console messages captured)'
                    : messages.map(message => `[${message.type}] ${message.text}`).join('\n');
                return textBlock(rows);
            },
        },
        execute: async () => {
            const messages = session.consoleEntries().map(entry => ({
                type: entry.type,
                text: entry.text,
                location: entry.location,
            }));
            return { ok: true, messages: messages };
        },
    }));
    if (config.capabilities.network) {
        tools.push(defineTool({
            name: 'browser_network_requests',
            description: 'Return captured network requests/responses from the browser context (capped ring buffer).',
            parameters: {
                url: { type: 'string', description: 'Only requests whose URL contains this substring' },
                method: { type: 'string', description: 'Only requests with this HTTP method' },
                resourceType: { type: 'string', description: 'Only requests with this resource type (e.g. fetch, xhr, document)' },
                status: { type: 'integer', description: 'Only requests with this HTTP status' },
                limit: { type: 'number', description: 'Maximum number of entries to return; defaults to 25' },
            },
            output: {
                schema: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        ok: { type: 'boolean', required: true },
                        requests: { type: 'array', items: { type: 'json' }, required: true },
                    },
                },
                render: (_args, value) => {
                    const requests = value.requests;
                    const rows = requests.length === 0
                        ? '(no matching network requests captured)'
                        : requests.map(request => `${request.method} ${request.status ?? '…'} ${request.url}`).join('\n');
                    return textBlock(rows);
                },
            },
            execute: async ({ url, method, resourceType, status, limit }) => {
                let entries = session.networkEntries();
                if (url !== undefined)
                    entries = entries.filter(entry => entry.url.includes(url));
                if (method !== undefined)
                    entries = entries.filter(entry => entry.method.toUpperCase() === method.toUpperCase());
                if (resourceType !== undefined)
                    entries = entries.filter(entry => entry.resourceType === resourceType);
                if (status !== undefined)
                    entries = entries.filter(entry => entry.status === status);
                const requests = entries.slice(-(limit ?? 25)).map(entry => ({
                    method: entry.method,
                    url: entry.url,
                    resourceType: entry.resourceType,
                    status: entry.status,
                    statusText: entry.statusText,
                    failure: entry.failure,
                }));
                return { ok: true, requests: requests };
            },
        }));
    }
    return tools;
}
