/**
 * Browser session lifecycle for dsh-plugin-playwright.
 *
 * Owns the Playwright browser + context, a tab registry (shared mode), and
 * ring buffers for console/network observations. Every tool executes through
 * {@link BrowserSession.run}, which in shared mode reuses one persistent
 * context (state survives between calls) and in isolated mode creates a fresh
 * context per call and closes it afterwards.
 *
 * @module dsh-plugin-playwright/browser
 */
import { type BrowserContext, type Page } from 'playwright';
import type { Config } from './config.ts';
/** One captured console message. */
export interface ConsoleEntry {
    type: string;
    text: string;
    location: {
        url: string;
        lineNumber: number;
        columnNumber: number;
    };
}
/** One captured network request (status filled in when the response lands). */
export interface NetworkEntry {
    method: string;
    url: string;
    resourceType: string;
    status: number | null;
    statusText: string | null;
    failure: string | null;
}
/**
 * Per-call view of the browser state a tool operates on. In shared mode this
 * wraps the session's persistent context; in isolated mode it wraps a
 * throwaway context that is closed by {@link BrowserSession.run} when the
 * tool returns.
 */
export interface CallHandle {
    readonly context: BrowserContext;
    /** The page a tool should act on (the active tab in shared mode). */
    activePage(): Page;
    /** Create a new tab/page and make it active. */
    newPage(): Promise<Page>;
    /** Switch the active tab. */
    activate(page: Page): void;
    /** Look up a tab by its stable id. */
    tabById(id: number): Page | undefined;
    /** Stable tab id of the active page, if any. */
    activeTabId(): number | undefined;
    /** Recent console messages, oldest first. */
    consoleEntries(): ConsoleEntry[];
    /** Recent network entries, oldest first. */
    networkEntries(): NetworkEntry[];
    /** Release per-call resources. No-op for the shared handle. */
    close(): Promise<void>;
}
/** Abort an in-flight Playwright operation when the harness cancels the call. */
export declare function withAbort<T>(signal: AbortSignal, promise: Promise<T>): Promise<T>;
/**
 * Lazily-started browser manager. The browser launches on the first tool call
 * (fast plugin activation) and closes when the plugin fiber disposes.
 */
export declare class BrowserSession {
    private readonly config;
    private browser;
    private context;
    private readonly tabs;
    private nextTabId;
    private activeTab;
    private started;
    private buffers;
    private readonly sharedHandle;
    constructor(config: Config);
    /** Launch the browser and shared context on first use. */
    ensureStarted(): Promise<void>;
    /** Build shared-context options from the plugin config. */
    private contextOptions;
    private attachListeners;
    /** Run one tool body against a shared or throwaway browser view. */
    run<T>(fn: (handle: CallHandle) => Promise<T>): Promise<T>;
    /** The active page of the shared context (defaulting to the first tab). */
    activePage(): Page;
    registerTab(page: Page): number;
    private dropTab;
    activateTab(page: Page): void;
    /** Look up a registered tab by id. */
    findTab(id: number): Page | undefined;
    get activeTabId(): number | undefined;
    listTabs(): Promise<Array<{
        id: number;
        url: string;
        title: string;
    }>>;
    consoleEntries(): ConsoleEntry[];
    networkEntries(): NetworkEntry[];
    requireContext(): BrowserContext;
    /** Close the browser and all contexts; idempotent. */
    close(): Promise<void>;
}
