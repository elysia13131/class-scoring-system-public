/**
 * Navigation behaviour — moving the active page and waiting for it to settle.
 *
 * These tools change where the page points or pause until a page condition is
 * met. They share a common shape: act on the active page, then return its state
 * (optionally with an accessibility snapshot).
 *
 * @module dsh-plugin-playwright/tools/navigation
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { stateSchema } from './schema.js';
import { abortable, pageState, renderStateText, textBlock } from './util.js';
/** Build every navigation tool for one plugin instance. */
export function createNavigationTools(session, config) {
    const withSnapshot = config.capabilities.accessibility;
    const timeout = config.timeoutMs;
    const tools = [];
    tools.push(defineTool({
        name: 'browser_navigate',
        description: 'Navigate the active page to a URL and wait for it to load. Returns the new URL, title, and an accessibility snapshot with element refs for later actions.',
        parameters: {
            url: { type: 'string', required: true, description: 'Absolute URL to navigate to (http/https/file/data)' },
            waitUntil: {
                type: 'string', enum: ['load', 'domcontentloaded', 'commit', 'networkidle'],
                description: 'Wait condition; defaults to the plugin navigationWaitUntil (load)',
            },
        },
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, `navigated to ${value.url}`)) },
        execute: async ({ url, waitUntil }, exec) => session.run(async (handle) => {
            const page = handle.activePage();
            await abortable(exec, page.goto(url, { waitUntil: waitUntil ?? config.navigationWaitUntil, timeout }));
            return pageState(handle, withSnapshot);
        }),
    }));
    tools.push(defineTool({
        name: 'browser_back',
        description: 'Navigate the active page back in history.',
        parameters: {},
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, 'went back')) },
        execute: async (_args, exec) => session.run(async (handle) => {
            const page = handle.activePage();
            const result = await abortable(exec, page.goBack({ waitUntil: config.navigationWaitUntil, timeout }));
            if (result === null)
                throw new Error('no previous page in history');
            return pageState(handle, withSnapshot);
        }),
    }));
    tools.push(defineTool({
        name: 'browser_forward',
        description: 'Navigate the active page forward in history.',
        parameters: {},
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, 'went forward')) },
        execute: async (_args, exec) => session.run(async (handle) => {
            const page = handle.activePage();
            const result = await abortable(exec, page.goForward({ waitUntil: config.navigationWaitUntil, timeout }));
            if (result === null)
                throw new Error('no next page in history');
            return pageState(handle, withSnapshot);
        }),
    }));
    tools.push(defineTool({
        name: 'browser_reload',
        description: 'Reload the active page.',
        parameters: {},
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, 'reloaded')) },
        execute: async (_args, exec) => session.run(async (handle) => {
            const page = handle.activePage();
            await abortable(exec, page.reload({ waitUntil: config.navigationWaitUntil, timeout }));
            return pageState(handle, withSnapshot);
        }),
    }));
    tools.push(defineTool({
        name: 'browser_wait_for',
        description: 'Wait for an element matching a CSS selector to reach a state (default visible).',
        parameters: {
            selector: { type: 'string', required: true, description: 'CSS selector to wait for' },
            state: { type: 'string', enum: ['attached', 'detached', 'visible', 'hidden'], description: 'Target state; defaults to visible' },
            timeout: { type: 'number', description: 'Override the default timeout in milliseconds' },
        },
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, 'wait finished')) },
        execute: async ({ selector, state, timeout: waitTimeout }, exec) => session.run(async (handle) => {
            const page = handle.activePage();
            await abortable(exec, page.waitForSelector(selector, { state: state ?? 'visible', timeout: waitTimeout ?? timeout }));
            return pageState(handle, withSnapshot);
        }),
    }));
    return tools;
}
