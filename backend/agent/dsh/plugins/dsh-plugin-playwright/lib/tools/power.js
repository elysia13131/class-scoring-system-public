/**
 * Power tool behaviour — a deliberate escape hatch into the page's JS runtime.
 *
 * `browser_evaluate` is gated behind the plugin's `evaluate` config (off by
 * default) because it bypasses the restrictive action model: it can both read
 * and write arbitrary page state. It lives alone in this module so its elevated
 * privilege is obvious at a glance.
 *
 * @module dsh-plugin-playwright/tools/power
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { abortable, textBlock } from './util.js';
/** Build the `browser_evaluate` tool when the `evaluate` capability is on. */
export function createPowerTools(session, config) {
    if (!config.evaluate) {
        return [];
    }
    const tools = [];
    tools.push(defineTool({
        name: 'browser_evaluate',
        description: 'Evaluate a JavaScript expression or function in the active page and return the JSON-serializable result. Enabled via the plugin "evaluate" config.',
        parameters: {
            script: { type: 'string', required: true, description: 'JavaScript expression or function body to evaluate' },
            arg: { type: 'json', description: 'Optional argument passed as the first parameter' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    result: { type: 'json', required: true },
                },
            },
            render: (_args, value) => textBlock(`evaluate result:\n${JSON.stringify(value.result, null, 2)}`),
        },
        execute: async ({ script, arg }, exec) => session.run(async (handle) => {
            const page = handle.activePage();
            const result = await abortable(exec, page.evaluate(script, arg));
            // undefined is not lossless JSON; normalize to null.
            return { ok: true, result: result === undefined ? null : result };
        }),
    }));
    return tools;
}
