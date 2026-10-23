/**
 * Navigation behaviour — moving the active page and waiting for it to settle.
 *
 * These tools change where the page points or pause until a page condition is
 * met. They share a common shape: act on the active page, then return its state
 * (optionally with an accessibility snapshot).
 *
 * @module dsh-plugin-playwright/tools/navigation
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { BrowserSession } from '../browser.ts';
import type { Config } from '../config.ts';
/** Build every navigation tool for one plugin instance. */
export declare function createNavigationTools(session: BrowserSession, config: Config): ToolDefinition[];
