/**
 * dsh-plugin-playwright — Playwright browser automation tools for DeepSeek
 * Harness.
 *
 * The plugin registers the `browser_*` tool family on `ctx.tools`. The
 * Playwright browser is launched lazily on the first tool call and closed when
 * the plugin fiber disposes (HMR reload included). One plugin instance owns one
 * shared browser; load one instance when you need browser automation.
 *
 * @module dsh-plugin-playwright
 */
import { BrowserSession } from './browser.js';
import { Config } from './config.js';
import { createTools } from './tools/factory.js';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-plugin-playwright';
/** Services required by this plugin. */
export const inject = ['tools'];
export { Config };
/**
 * Register the browser tools and own the browser lifecycle. Registration is
 * effect-based: when this fiber unloads, every tool is unregistered and the
 * browser is closed.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
    const session = new BrowserSession(config);
    ctx.effect(() => {
        return () => {
            void session.close();
        };
    }, 'dsh-plugin-playwright.session');
    for (const tool of createTools(session, config)) {
        ctx.tools.register(tool);
    }
}
