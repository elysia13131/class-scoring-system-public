/**
 * Capture behaviour — producing files from the active page or context.
 *
 * These tools write artifacts (images, PDFs, trace archives) under the plugin
 * output directory rather than returning in-band state. PDFs and tracing are
 * gated behind capabilities.
 *
 * @module dsh-plugin-playwright/tools/capture
 */
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { fileResultSchema } from './schema.js';
import { abortable, ensureOutputDir, textBlock, timestamp } from './util.js';
/** Build every capture tool for one plugin instance. */
export function createCaptureTools(session, config) {
    const timeout = config.timeoutMs;
    const tools = [];
    if (config.capabilities.screenshot) {
        tools.push(defineTool({
            name: 'browser_screenshot',
            description: 'Capture a screenshot of the active page and save it under the plugin output directory. Returns the saved file path.',
            parameters: {
                fullPage: { type: 'boolean', description: 'Capture the full scrollable page; defaults to false' },
                format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format; defaults to png' },
            },
            output: { schema: fileResultSchema, render: (_args, value) => textBlock(`screenshot saved to ${value.path}\nurl: ${value.url}\ntitle: ${value.title}${value.width !== undefined && value.height !== undefined ? `\nsize: ${value.width}x${value.height}` : ''}`) },
            execute: async ({ fullPage, format }, exec) => session.run(async (handle) => {
                const page = handle.activePage();
                const dir = await ensureOutputDir(config);
                const file = path.join(dir, `screenshot-${timestamp()}.${format === 'jpeg' ? 'jpg' : 'png'}`);
                await abortable(exec, page.screenshot({ path: file, fullPage: fullPage ?? false, type: format ?? 'png' }));
                const viewport = page.viewportSize();
                return {
                    ok: true,
                    path: file,
                    url: page.url(),
                    title: await page.title(),
                    // Spread conditionally: an undefined viewport would make the value
                    // fail the harness's lossless-JSON output validation.
                    ...(viewport !== null ? { width: viewport.width, height: viewport.height } : {}),
                };
            }),
        }));
    }
    if (config.capabilities.pdf) {
        tools.push(defineTool({
            name: 'browser_pdf',
            description: 'Print the active page to a PDF file under the plugin output directory (chromium only).',
            parameters: { path: { type: 'string', description: 'Explicit output path; defaults to a timestamped file in the output directory' } },
            output: { schema: fileResultSchema, render: (_args, value) => textBlock(`pdf saved to ${value.path}\nurl: ${value.url}\ntitle: ${value.title}`) },
            execute: async ({ path: explicitPath }, exec) => session.run(async (handle) => {
                const page = handle.activePage();
                if (config.browser !== 'chromium' && config.browser !== 'msedge') {
                    throw new Error('browser_pdf is only supported on chromium/msedge');
                }
                const dir = await ensureOutputDir(config);
                const file = explicitPath ?? path.join(dir, `page-${timestamp()}.pdf`);
                await abortable(exec, page.pdf({ path: file }));
                return { ok: true, path: file, url: page.url(), title: await page.title() };
            }),
        }));
    }
    if (config.capabilities.tracing) {
        tools.push(defineTool({
            name: 'browser_tracing_start',
            description: 'Start tracing the shared browser context (screenshots + snapshots).',
            parameters: {
                name: { type: 'string', description: 'Trace name' },
                title: { type: 'string', description: 'Trace title' },
                screenshots: { type: 'boolean', description: 'Capture screenshots; defaults to true' },
                snapshots: { type: 'boolean', description: 'Capture DOM snapshots; defaults to true' },
            },
            output: {
                schema: {
                    type: 'object', additionalProperties: false,
                    properties: { ok: { type: 'boolean', required: true } },
                },
                render: () => textBlock('tracing started'),
            },
            execute: async ({ name, title, screenshots, snapshots }) => {
                await session.requireContext().tracing.start({ name, title, screenshots: screenshots ?? true, snapshots: snapshots ?? true });
                return { ok: true };
            },
        }));
        tools.push(defineTool({
            name: 'browser_tracing_stop',
            description: 'Stop tracing and save the trace zip under the plugin output directory.',
            parameters: { path: { type: 'string', description: 'Explicit output path; defaults to a timestamped file in the output directory' } },
            output: { schema: fileResultSchema, render: (_args, value) => textBlock(`trace saved to ${value.path}`) },
            execute: async ({ path: explicitPath }) => {
                const dir = await ensureOutputDir(config);
                const file = explicitPath ?? path.join(dir, `trace-${timestamp()}.zip`);
                await session.requireContext().tracing.stop({ path: file });
                return { ok: true, path: file, url: '', title: '' };
            },
        }));
    }
    return tools;
}
