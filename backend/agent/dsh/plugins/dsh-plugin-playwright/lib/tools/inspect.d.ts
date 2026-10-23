/**
 * Inspection behaviour — reading the page's current state back to the model.
 *
 * These tools are read-only observations: the accessibility tree, captured
 * console messages, and captured network traffic. They are the plugin's "eyes",
 * in contrast to the `interact` tools that change the page.
 *
 * @module dsh-plugin-playwright/tools/inspect
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { BrowserSession } from '../browser.ts';
import type { Config } from '../config.ts';
/** Build every inspection tool for one plugin instance. */
export declare function createInspectionTools(session: BrowserSession, config: Config): ToolDefinition[];
