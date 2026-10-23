/**
 * Interaction behaviour — mutating the page through its elements.
 *
 * These tools act on a target element (referenced by snp ref or CSS selector)
 * and return the resulting page state. They are the "hands" of the plugin,
 * contrasting with the read-only `inspect` tools and the session-level
 * `control` tools.
 *
 * @module dsh-plugin-playwright/tools/interact
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { BrowserSession } from '../browser.ts';
import type { Config } from '../config.ts';
/** Build every interaction tool for one plugin instance. */
export declare function createInteractionTools(session: BrowserSession, config: Config): ToolDefinition[];
