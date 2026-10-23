/**
 * Plugin configuration for dsh-plugin-playwright.
 *
 * Declares the knobs that shape a plugin instance: the browser engine, its
 * headless/persistent profile, viewport, locale settings and per-capability
 * toggles.
 *
 * @module dsh-plugin-playwright/config
 */
import z from '@deepseek-ai/schemastery';
export const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const DEFAULT_CAPABILITIES = {
    accessibility: true,
    screenshot: true,
    pdf: true,
    network: true,
    tracing: false,
    storageState: false,
};
export const Config = z.object({
    browser: z.union([z.const('chromium'), z.const('firefox'), z.const('webkit'), z.const('msedge')]).default('chromium'),
    headless: z.boolean().default(true),
    channel: z.string(),
    executablePath: z.string(),
    /** Network proxy for the shared browser context, e.g. `socks5://127.0.0.1:1090`
     * or `http://user:pass@host:8080`. Empty / `direct` / `off` = no proxy.
     * Read at launch time; switch at runtime via the `browser_proxy` tool. */
    proxy: z.string().default(''),
    userDataDir: z.string(),
    isolated: z.boolean().default(false),
    viewport: z.object({
        width: z.number().min(1).default(DEFAULT_VIEWPORT.width),
        height: z.number().min(1).default(DEFAULT_VIEWPORT.height),
    }).default({ width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height }),
    device: z.string(),
    locale: z.string(),
    timezoneId: z.string(),
    colorScheme: z.union([z.const('light'), z.const('dark'), z.const('no-preference')]),
    /** Community anti-automation hardening (fork): disables the automation
     * blink feature, neutralises navigator.webdriver / empty plugin list, and
     * restores chrome.* and permission surfaces headless builds hide. */
    stealth: z.boolean().default(true),
    outputDir: z.string().default('.dsh/playwright'),
    timeoutMs: z.number().min(100).default(30_000),
    navigationWaitUntil: z.union([z.const('load'), z.const('domcontentloaded'), z.const('commit'), z.const('networkidle')]).default('load'),
    capabilities: z.object({
        accessibility: z.boolean().default(DEFAULT_CAPABILITIES.accessibility),
        screenshot: z.boolean().default(DEFAULT_CAPABILITIES.screenshot),
        pdf: z.boolean().default(DEFAULT_CAPABILITIES.pdf),
        network: z.boolean().default(DEFAULT_CAPABILITIES.network),
        tracing: z.boolean().default(DEFAULT_CAPABILITIES.tracing),
        storageState: z.boolean().default(DEFAULT_CAPABILITIES.storageState),
    }).default({ ...DEFAULT_CAPABILITIES }),
    evaluate: z.boolean().default(false),
});
