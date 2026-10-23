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
/** Browser engine selection. */
export type BrowserName = 'chromium' | 'firefox' | 'webkit' | 'msedge';
/** Navigation wait condition, matching Playwright's `waitUntil`. */
export type NavigationWaitUntil = 'load' | 'domcontentloaded' | 'commit' | 'networkidle';
/** Color scheme handed to the browser context. */
export type ColorScheme = 'light' | 'dark' | 'no-preference';
/**
 * Per-capability toggles. Disabled capabilities either gate registration of the
 * corresponding tool or strip the snapshot/state data from results.
 */
export interface Capabilities {
    /** Return the accessibility snapshot from state-bearing tools. */
    accessibility: boolean;
    /** Register `browser_screenshot`. */
    screenshot: boolean;
    /** Register `browser_pdf` (chromium only). */
    pdf: boolean;
    /** Register `browser_network_requests` and buffer network entries. */
    network: boolean;
    /** Register `browser_tracing_start` / `browser_tracing_stop`. */
    tracing: boolean;
    /** Register `browser_storage_state` and `browser_init_script`. */
    storageState: boolean;
}
/** Plugin configuration. */
export interface Config {
    /** Browser engine to launch; `msedge` maps to chromium with the msedge channel. */
    browser: BrowserName;
    /** Run headless (no visible window). Defaults to true. */
    headless: boolean;
    /** Browser channel, e.g. `chrome`, `msedge`, `chrome-beta`. */
    channel?: string;
    /**
     * Absolute path to a browser executable to launch instead of Playwright's
     * managed build (useful with pre-downloaded browsers or corporate builds).
     * Overrides `channel`.
     */
    executablePath?: string;
    /**
     * Network proxy for the shared browser context, e.g.
     * `socks5://127.0.0.1:1090` or `http://user:pass@host:8080`.
     * Empty / `direct` / `off` = no proxy. Read at launch time; switch at
     * runtime via the `browser_proxy` tool.
     */
    proxy?: string;
    /**
     * Persistent user-data directory for the chromium context. When set, the
     * browser profile (cookies, localStorage, …) survives restarts. Requires
     * `browser: 'chromium'` or `'msedge'`.
     */
    userDataDir?: string;
    /**
     * Per-call isolation: when true, every tool call runs in a fresh browser
     * context that is closed when the call finishes, so state never survives
     * between calls.
     */
    isolated: boolean;
    /** Initial viewport size. */
    viewport: {
        width: number;
        height: number;
    };
    /** Device descriptor name (see `playwright.devices`), e.g. `iPhone 13`. */
    device?: string;
    /** Locale for the browser context. */
    locale?: string;
    /** IANA timezone id for the browser context. */
    timezoneId?: string;
    /** Preferred color scheme for the browser context. */
    colorScheme?: ColorScheme;
    /** Directory for screenshots / PDFs / traces produced by the tools. */
    outputDir: string;
    /** Default per-action timeout in milliseconds. */
    timeoutMs: number;
    /** Default wait condition for navigations. */
    navigationWaitUntil: NavigationWaitUntil;
    /** Per-capability toggles. */
    capabilities: Capabilities;
    /**
     * Register `browser_evaluate`. Off by default because arbitrary page-side
     * script execution is a powerful primitive; enable only in trusted
     * deployments.
     */
    evaluate: boolean;
}
export declare const DEFAULT_VIEWPORT: {
    readonly width: 1280;
    readonly height: 720;
};
export declare const Config: z<Config>;
