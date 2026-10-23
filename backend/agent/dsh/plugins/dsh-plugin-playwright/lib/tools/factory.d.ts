/**
 * Tool assembly — collects every behaviour module's tools into one surface.
 *
 * This is the single place that builds the full `browser_*` tool set for one
 * plugin instance. Each behaviour module applies its own capability gating, so
 * this factory only concatenates their outputs in a stable order.
 *
 * @module dsh-plugin-playwright/tools/factory
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { BrowserSession } from '../browser.ts';
import type { Config } from '../config.ts';
/**
 * Build every registered tool for one plugin instance.
 * @param session - shared browser session (lazy start, per-call isolation).
 * @param config - validated plugin config.
 */
export declare function createTools(session: BrowserSession, config: Config): ToolDefinition[];
