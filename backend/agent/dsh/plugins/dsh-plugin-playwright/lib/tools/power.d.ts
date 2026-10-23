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
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { BrowserSession } from '../browser.ts';
import type { Config } from '../config.ts';
/** Build the `browser_evaluate` tool when the `evaluate` capability is on. */
export declare function createPowerTools(session: BrowserSession, config: Config): ToolDefinition[];
