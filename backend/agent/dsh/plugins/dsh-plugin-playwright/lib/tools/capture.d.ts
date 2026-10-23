/**
 * Capture behaviour — producing files from the active page or context.
 *
 * These tools write artifacts (images, PDFs, trace archives) under the plugin
 * output directory rather than returning in-band state. PDFs and tracing are
 * gated behind capabilities.
 *
 * @module dsh-plugin-playwright/tools/capture
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { BrowserSession } from '../browser.ts';
import type { Config } from '../config.ts';
/** Build every capture tool for one plugin instance. */
export declare function createCaptureTools(session: BrowserSession, config: Config): ToolDefinition[];
