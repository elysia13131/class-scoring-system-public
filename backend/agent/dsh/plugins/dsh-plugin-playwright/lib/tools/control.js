/**
 * Control behaviour — operating the session itself rather than page contents.
 *
 * These tools manage tabs, the shared viewport, and session persistence
 * (storage state and initial scripts). They are the plugin's "steering wheel"
 * for the browser session's life, as opposed to the page-focused `navigate`,
 * `interact` and `inspect` groups.
 *
 * @module dsh-plugin-playwright/tools/control
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { stateSchema, tabStateSchema } from './schema.js';
import { abortable, pageState, renderStateText, textBlock } from './util.js';
/** Look up a tab page by id in the call's context. */
function tabById(handle, id) {
    const page = handle.tabById(id);
    if (!page)
        throw new Error(`no open tab with id ${id} — use browser_tab_list to see the open tabs`);
    return page;
}
/** Build every control tool for one plugin instance. */
export function createControlTools(session, config) {
    const withSnapshot = config.capabilities.accessibility;
    const timeout = config.timeoutMs;
    const tools = [];
    tools.push(defineTool({
        name: 'browser_proxy',
        description: 'View or switch the network proxy of the shared browser (empty / "direct" / "off" clears it, going direct). Switching relaunches the browser so it applies from the next call; the persistent profile (cookies/logins) is kept. Use it to reach sites this server cannot reach directly — e.g. a campus intranet behind a SOCKS5 tunnel: proxy = "socks5://HOST:PORT". Optionally pass testUrl to confirm the new route actually works before using it.',
        parameters: {
            proxy: { type: 'string', description: 'Proxy URL, e.g. socks5://127.0.0.1:1090 or http://user:pass@host:8080. Empty / direct / off = no proxy. Omit to only report the current proxy.' },
            testUrl: { type: 'string', description: 'Optional URL to open after switching, to verify the route (e.g. https://icanhazip.com to see the egress IP).' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    proxy: { type: 'string', required: true },
                    changed: { type: 'boolean', required: true },
                    relaunched: { type: 'boolean', required: true },
                    test: { type: 'json' },
                },
            },
            render: (args, value) => textBlock(`browser proxy: ${value.proxy}${value.changed ? (value.relaunched ? ' (switched & relaunched)' : ' (switched)') : ' (unchanged)'}${value.test ? (value.test.ok ? `\ntest ok: ${value.test.url}${value.test.title ? ' — ' + value.test.title : ''}` : `\ntest failed: ${value.test.error}`) : ''}`),
        },
        execute: async ({ proxy, testUrl }) => {
            if (proxy === undefined && testUrl === undefined) {
                return { ok: true, proxy: session.currentProxy() || 'direct', changed: false, relaunched: false, test: null };
            }
            const r = await session.switchProxy(proxy === undefined ? session.currentProxy() : proxy, { testUrl });
            return { ok: true, proxy: r.proxy, changed: r.changed, relaunched: r.relaunched, test: r.test };
        },
    }));
    tools.push(defineTool({
        name: 'browser_tab_new',
        description: 'Open a new tab, optionally navigating it to a URL, and make it the active tab.',
        parameters: { url: { type: 'string', description: 'Optional URL to open in the new tab' } },
        output: { schema: tabStateSchema, render: (args, value) => textBlock(`opened tab ${value.tabId ?? '?'}${args.url ? ` at ${args.url}` : ''}\nurl: ${value.url}\ntitle: ${value.title}`) },
        execute: async ({ url }, exec) => session.run(async (handle) => {
            const page = await handle.newPage();
            if (url !== undefined) {
                await abortable(exec, page.goto(url, { waitUntil: config.navigationWaitUntil, timeout }));
            }
            const tabId = handle.activeTabId();
            const state = await pageState(handle, withSnapshot);
            return { ...state, tabId };
        }),
    }));
    tools.push(defineTool({
        name: 'browser_tab_switch',
        description: 'Switch the active tab to an existing tab by id (see browser_tab_list).',
        parameters: { id: { type: 'number', required: true, description: 'Tab id to activate' } },
        output: { schema: tabStateSchema, render: (_args, value) => textBlock(`switched to tab ${value.tabId}\nurl: ${value.url}\ntitle: ${value.title}`) },
        execute: async ({ id }, exec) => session.run(async (handle) => {
            const page = tabById(handle, id);
            handle.activate(page);
            const state = await pageState(handle, withSnapshot);
            return { ...state, tabId: id };
        }),
    }));
    tools.push(defineTool({
        name: 'browser_tab_close',
        description: 'Close a tab (defaults to the active tab).',
        parameters: { id: { type: 'number', description: 'Tab id to close; defaults to the active tab' } },
        output: { schema: tabStateSchema, render: (_args, value) => textBlock('tab closed') },
        execute: async ({ id }, exec) => session.run(async (handle) => {
            const page = id !== undefined ? tabById(handle, id) : handle.activePage();
            await abortable(exec, page.close());
            const state = await pageState(handle, withSnapshot);
            return { ...state, tabId: handle.activeTabId() };
        }),
    }));
    tools.push(defineTool({
        name: 'browser_tab_list',
        description: 'List all open tabs with their ids, urls, and titles.',
        parameters: {},
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    tabs: { type: 'array', items: { type: 'json' }, required: true },
                },
            },
            render: (_args, value) => {
                const rows = value.tabs
                    .map(tab => `- tab ${tab.id}: ${tab.title} (${tab.url})`)
                    .join('\n');
                return textBlock(`open tabs:\n${rows}`);
            },
        },
        execute: async () => {
            const tabs = await session.listTabs();
            return { ok: true, tabs: tabs };
        },
    }));
    tools.push(defineTool({
        name: 'browser_resize',
        description: 'Resize the viewport of the active page.',
        parameters: {
            width: { type: 'number', required: true, description: 'New viewport width in pixels' },
            height: { type: 'number', required: true, description: 'New viewport height in pixels' },
        },
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, 'resized viewport')) },
        execute: async ({ width, height }, exec) => session.run(async (handle) => {
            const page = handle.activePage();
            await abortable(exec, page.setViewportSize({ width, height }));
            return pageState(handle, withSnapshot);
        }),
    }));
    if (config.capabilities.storageState) {
        tools.push(defineTool({
            name: 'browser_storage_state',
            description: 'Return the storage state (cookies + localStorage) of the shared browser context.',
            parameters: {},
            output: {
                schema: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        ok: { type: 'boolean', required: true },
                        storageState: { type: 'json', required: true },
                    },
                },
                render: (_args, value) => textBlock(`storage state:\n${JSON.stringify(value.storageState, null, 2)}`),
            },
            execute: async () => {
                const storageState = await session.requireContext().storageState();
                return { ok: true, storageState: storageState };
            },
        }));
        tools.push(defineTool({
            name: 'browser_init_script',
            description: 'Register a script that runs before every future page load in the shared context.',
            parameters: { script: { type: 'string', required: true, description: 'JavaScript to run at document creation time' } },
            output: {
                schema: {
                    type: 'object', additionalProperties: false,
                    properties: { ok: { type: 'boolean', required: true } },
                },
                render: () => textBlock('init script registered'),
            },
            execute: async ({ script }) => {
                await session.requireContext().addInitScript(script);
                return { ok: true };
            },
        }));
    }
    return tools;
}
