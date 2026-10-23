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
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { BrowserSession } from '../browser.ts';
import type { Config } from '../config.ts';
/** Build every control tool for one plugin instance. */
export declare function createControlTools(session: BrowserSession, config: Config): ToolDefinition[];
