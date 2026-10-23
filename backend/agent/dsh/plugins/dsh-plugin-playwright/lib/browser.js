/**
 * Browser session lifecycle for dsh-plugin-playwright.
 *
 * Owns the Playwright browser + context, a tab registry (shared mode), and
 * ring buffers for console/network observations. Every tool executes through
 * {@link BrowserSession.run}, which in shared mode reuses one persistent
 * context (state survives between calls) and in isolated mode creates a fresh
 * context per call and closes it afterwards.
 *
 * Fork: driver auto-upgrade — when `patchright` is resolvable (installed in
 * this package's reachable node_modules) it is preferred over playwright.
 * Patchright strips the deterministic automation surface (Runtime.enable
 * timing, --enable-automation flags) at the driver layer, which is what modern
 * WAFs read before any page JS runs. Patchright only ships the chromium
 * engine: firefox/webkit fall back to playwright when available, otherwise
 * they error out.
 *
 * @module dsh-plugin-playwright/browser
 */
let chromium;
let firefox;
let webkit;
let devices;
let driver = 'playwright';
try {
    // Patchright is a drop-in chromium driver; prefer it when present.
    ({ chromium, devices } = await import('patchright'));
    driver = 'patchright';
}
catch {
    ({ chromium, firefox, webkit, devices } = await import('playwright'));
}
import { existsSync, readlinkSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
const MAX_CONSOLE_ENTRIES = 200;
const MAX_NETWORK_ENTRIES = 500;
/** Normalise a user-supplied proxy value to a URL string, or '' for direct. */
function normalizeProxy(value) {
    if (value == null)
        return '';
    const raw = String(value).trim().replace(/^["']|["']$/g, '');
    if (!raw || /^(direct|off|none|no[ -]?proxy)$/i.test(raw))
        return '';
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : 'http://' + raw;
}
/** Map a proxy URL to the Playwright `proxy` launch option (creds separated). */
function proxyOptions(value) {
    const raw = normalizeProxy(value);
    if (!raw)
        return undefined;
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        return { server: raw };
    }
    const opt = { server: `${parsed.protocol}//${parsed.host}` };
    if (parsed.username) {
        opt.username = decodeURIComponent(parsed.username);
        opt.password = parsed.password ? decodeURIComponent(parsed.password) : '';
    }
    return opt;
}
/** Abort an in-flight Playwright operation when the harness cancels the call. */
export function withAbort(signal, promise) {
    if (signal.aborted) {
        return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then((value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
}
function createBuffers() {
    return { console: [], network: [] };
}
function attachBuffers(context, buffers) {
    context.on('console', (message) => {
        buffers.console.push({
            type: message.type(),
            text: message.text(),
            location: message.location(),
        });
        if (buffers.console.length > MAX_CONSOLE_ENTRIES)
            buffers.console.shift();
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- keyed by Playwright's Request handle
    const pendingRequests = new Map();
    context.on('request', (request) => {
        const entry = {
            method: request.method(),
            url: request.url(),
            resourceType: request.resourceType(),
            status: null,
            statusText: null,
            failure: null,
        };
        pendingRequests.set(request, entry);
    });
    context.on('response', (response) => {
        const request = response.request();
        const entry = pendingRequests.get(request);
        if (!entry)
            return;
        entry.status = response.status();
        entry.statusText = response.statusText();
        pendingRequests.delete(request);
        buffers.network.push(entry);
        if (buffers.network.length > MAX_NETWORK_ENTRIES)
            buffers.network.shift();
    });
    context.on('requestfailed', (request) => {
        const entry = pendingRequests.get(request);
        if (!entry)
            return;
        entry.failure = request.failure()?.errorText ?? 'failed';
        pendingRequests.delete(request);
        buffers.network.push(entry);
        if (buffers.network.length > MAX_NETWORK_ENTRIES)
            buffers.network.shift();
    });
}
/** Shared-mode handle over the session's persistent context. */
class SharedHandle {
    session;
    constructor(session) {
        this.session = session;
    }
    get context() {
        return this.session.requireContext();
    }
    activePage() {
        return this.session.activePage();
    }
    async newPage() {
        const page = await this.context.newPage();
        this.session.registerTab(page);
        return page;
    }
    activate(page) {
        this.session.activateTab(page);
    }
    tabById(id) {
        return this.session.findTab(id);
    }
    activeTabId() {
        return this.session.activeTabId;
    }
    consoleEntries() {
        return this.session.consoleEntries();
    }
    networkEntries() {
        return this.session.networkEntries();
    }
    async close() {
        // Shared context lives for the plugin lifetime.
    }
}
/** Isolated-mode handle over one throwaway context + page. */
class IsolatedHandle {
    ctx;
    page;
    buffers;
    constructor(ctx, page, buffers) {
        this.ctx = ctx;
        this.page = page;
        this.buffers = buffers;
    }
    get context() {
        return this.ctx;
    }
    activePage() {
        return this.page;
    }
    async newPage() {
        return this.ctx.newPage();
    }
    activate() {
        // Isolated calls own a single context; there is nothing to switch to.
    }
    tabById(id) {
        return id === 1 ? this.page : undefined;
    }
    activeTabId() {
        return 1;
    }
    consoleEntries() {
        return this.buffers.console;
    }
    networkEntries() {
        return this.buffers.network;
    }
    async close() {
        await this.ctx.close().catch(() => { });
    }
}
/**
 * Lazily-started browser manager. The browser launches on the first tool call
 * (fast plugin activation) and closes when the plugin fiber disposes.
 */
export class BrowserSession {
    config;
    browser;
    context;
    tabs = new Map();
    nextTabId = 1;
    activeTab;
    started = false;
    buffers = createBuffers();
    sharedHandle = new SharedHandle(this);
    constructor(config) {
        this.config = config;
        this._proxy = normalizeProxy(config.proxy);
    }
    /** Sidecar file holding the runtime proxy override, kept next to the
     * persistent profile so a proxy switch survives worker recycling. */
    proxyFile() {
        return this.config.userDataDir !== undefined ? `${this.config.userDataDir}.proxy` : null;
    }
    loadSavedProxy() {
        const file = this.proxyFile();
        if (!file)
            return null;
        try {
            const saved = JSON.parse(readFileSync(file, 'utf8'));
            return typeof saved.proxy === 'string' ? normalizeProxy(saved.proxy) : null;
        }
        catch {
            return null;
        }
    }
    persistProxy() {
        const file = this.proxyFile();
        if (!file)
            return;
        try {
            writeFileSync(file, JSON.stringify({ proxy: this._proxy }));
        }
        catch { /* proxy persistence is best-effort */ }
    }
    /** The effective proxy URL ('' = direct). */
    currentProxy() {
        return this._proxy;
    }
    /** Map the effective proxy to a Playwright launch/context option. */
    proxySettings() {
        return proxyOptions(this._proxy);
    }
    /**
     * Switch the network proxy of the shared browser. When the browser is
     * already running the persistent context is relaunched so the new proxy
     * applies to subsequent calls; the profile (cookies/logins) is preserved.
     * @param value proxy URL ('' / 'direct' / 'off' to go direct)
     * @returns status + optional probe result
     */
    async switchProxy(value, { testUrl } = {}) {
        const next = normalizeProxy(value);
        const changed = next !== this._proxy;
        this._proxy = next;
        this.persistProxy();
        let relaunched = false;
        if (changed && this.started) {
            await this.close();
            relaunched = true; // next ensureStarted() launches with the new proxy
        }
        let test = null;
        if (testUrl) {
            try {
                await this.ensureStarted();
                const page = this.activePage();
                await page.goto(testUrl, {
                    waitUntil: this.config.navigationWaitUntil,
                    timeout: Math.max(this.config.timeoutMs, 45_000),
                });
                test = { ok: true, url: page.url(), title: await page.title().catch(() => '') };
            }
            catch (e) {
                test = { ok: false, error: (e && e.message) || String(e) };
            }
        }
        return { changed, relaunched, proxy: this._proxy || 'direct', test };
    }
    /** Launch the browser and shared context on first use. */
    async ensureStarted() {
        if (this.started)
            return;
        this.started = true;
        const { config } = this;
        // A runtime proxy switch is persisted next to the profile and wins over
        // the config default, so the choice survives worker recycling.
        const saved = this.loadSavedProxy();
        if (saved !== null)
            this._proxy = saved;
        if (driver === 'patchright' && config.browser !== 'chromium' && config.browser !== 'msedge') {
            throw new Error(`dsh-plugin-playwright: patchright driver only ships chromium/msedge — browser "${config.browser}" requires the playwright driver (install playwright and remove patchright, or set browser: chromium)`);
        }
        const browserType = config.browser === 'firefox'
            ? firefox
            : config.browser === 'webkit'
                ? webkit
                : chromium;
        // `msedge` maps to the chromium engine with the msedge channel, unless an
        // explicit executablePath (which overrides channel) is configured.
        const channel = config.executablePath === undefined && config.browser === 'msedge'
            ? (config.channel ?? 'msedge')
            : config.channel;
        const launchOptions = {
            headless: config.headless,
            channel: channel ?? undefined,
            executablePath: config.executablePath ?? undefined,
        };
        // Fork: stealth launch args (chromium engine only). Disables the
        // automation blink feature that leaks headless/automation signals to
        // fingerprinting scripts.
        if (config.stealth && browserType === chromium) {
            launchOptions.args = ['--disable-blink-features=AutomationControlled'];
        }
        // Fork: headless chromium's user agent carries a `HeadlessChrome` token
        // that WAFs (Meituan Optimus et al.) read before any JS runs — a dead
        // giveaway regardless of driver-layer stealth. When running on the
        // patchright driver in headless mode, derive the equivalent headful UA
        // (same engine/token minus `HeadlessChrome`) and pin it on the context
        // so the request header and navigator.userAgent stay consistent.
        let uaOverride;
        if (driver === 'patchright' && config.headless) {
            uaOverride = await this.headfulUserAgent(launchOptions);
        }
        try {
            if (config.userDataDir !== undefined) {
                if (browserType !== chromium) {
                    throw new Error('dsh-plugin-playwright: userDataDir (persistent profile) is only supported for chromium/msedge');
                }
                // Persistent context: the browser and its profile directory are one.
                // Clear any stale singleton lock first — an abnormal exit (crash /
                // container teardown) leaves SingletonLock* behind on the persistent
                // volume, which blocks every later launch even though the owner is
                // long dead.
                this.clearStaleSingletonLock(config.userDataDir);
                this.context = await chromium.launchPersistentContext(config.userDataDir, {
                    ...launchOptions,
                    ...this.contextOptions(),
                    ...(uaOverride ? { userAgent: uaOverride } : {}),
                });
            }
            else {
                this.browser = await browserType.launch(launchOptions);
                this.context = await this.browser.newContext({
                    ...this.contextOptions(),
                    ...(uaOverride ? { userAgent: uaOverride } : {}),
                });
            }
        }
        catch (error) {
            this.started = false;
            throw error;
        }
        this.attachListeners();
        if (config.stealth)
            await this.applyStealth(this.context);
        const initial = this.context.pages()[0] ?? await this.context.newPage();
        this.registerTab(initial);
    }
    /** Fork: read the engine's headful UA under the same launch options, then
     * strip the `HeadlessChrome` token. Best-effort and cached per session —
     * a failing probe never blocks browser startup. */
    async headfulUserAgent(baseOptions) {
        if (this._headfulUA !== undefined)
            return this._headfulUA;
        // Per-container cache: the probe spins up a second chromium instance,
        // which leaves zombie children behind when the parent worker exits.
        // Cache the result under /tmp (per-container) so it runs once per
        // container lifetime instead of once per session.
        const cachePath = join('/tmp', 'dsh-pw-headful-ua.json');
        const cacheKey = `${baseOptions.executablePath ?? ''}|${baseOptions.channel ?? ''}`;
        try {
            if (existsSync(cachePath)) {
                const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
                if (cached && cached.key === cacheKey && cached.ua) {
                    this._headfulUA = cached.ua;
                    return cached.ua;
                }
            }
        }
        catch { /* cache unreadable — probe afresh */ }
        try {
            const probe = await chromium.launch({
                headless: true,
                ...baseOptions,
                args: [...(baseOptions.args ?? []), '--disable-crash-reporter'],
            });
            try {
                const page = await probe.newPage();
                const raw = await page.evaluate(() => navigator.userAgent);
                this._headfulUA = raw.replace('HeadlessChrome', 'Chrome');
                try {
                    const tmp = `${cachePath}.${process.pid}.tmp`;
                    writeFileSync(tmp, JSON.stringify({ key: cacheKey, ua: this._headfulUA }));
                    rmSync(cachePath, { force: true });
                    const { renameSync } = await import('node:fs');
                    renameSync(tmp, cachePath);
                }
                catch { /* cache write is best-effort */ }
            }
            finally {
                await probe.close();
            }
        }
        catch {
            this._headfulUA = undefined;
        }
        return this._headfulUA;
    }
    /** Fork: chromium singleton lock hygiene for persistent profiles. Chromium
     * holds `SingletonLock` as a symlink to `<hostname>-<pid>`. When the owning
     * process dies without a clean shutdown (SIGKILL during container teardown,
     * crash), the lock stays behind on the persistent volume and blocks every
     * later launch. Remove it when it provably belongs to a dead owner:
     * different hostname (previous container/pod) or same hostname with a pid
     * that no longer exists. A live owner's lock is left untouched. */
    clearStaleSingletonLock(dir) {
        try {
            const lockPath = join(dir, 'SingletonLock');
            if (!existsSync(lockPath))
                return;
            const target = readlinkSync(lockPath).trim();
            const pidMatch = /-(\d+)$/.exec(target);
            if (!pidMatch) {
                rmSync(lockPath, { force: true });
                return;
            }
            const pid = Number(pidMatch[1]);
            const host = target.slice(0, target.length - pidMatch[1].length - 1);
            let sameHost = host === osHostname();
            let alive = false;
            if (sameHost) {
                try {
                    process.kill(pid, 0);
                    alive = true;
                }
                catch (e) {
                    alive = e.code === 'EPERM';
                }
            }
            if (sameHost && alive)
                return;
            rmSync(lockPath, { force: true });
            for (const name of ['SingletonSocket', 'SingletonCookie']) {
                try { rmSync(join(dir, name), { force: true }); } catch { /* ignore */ }
            }
        }
        catch { /* lock cleanup is best-effort */ }
    }
    /** Build shared-context options from the plugin config. */
    contextOptions() {
        const { config } = this;
        const options = {
            viewport: { width: config.viewport.width, height: config.viewport.height },
            acceptDownloads: true,
            locale: config.locale,
            timezoneId: config.timezoneId,
            colorScheme: config.colorScheme,
        };
        const proxy = this.proxySettings();
        if (proxy !== undefined)
            options.proxy = proxy;
        if (config.device !== undefined) {
            const descriptor = devices[config.device];
            if (!descriptor) {
                throw new Error(`dsh-plugin-playwright: unknown device "${config.device}" — see the keys of playwright.devices`);
            }
            Object.assign(options, descriptor);
            // An explicit plugin viewport wins over the device default.
            options.viewport = { width: config.viewport.width, height: config.viewport.height };
        }
        return options;
    }
    attachListeners() {
        const context = this.requireContext();
        attachBuffers(context, this.buffers);
        context.on('page', (page) => {
            this.registerTab(page);
            page.on('close', () => this.dropTab(page));
        });
    }
    /**
     * Fork: community anti-automation hardening. Injects an init script that
     * runs in every new document (all frames, including cross-origin ones) and
     * neutralises the fingerprints headless automation exposes: navigator
     * webdriver flag, empty plugin list, missing chrome.* surface, narrow
     * languages, and over-restrictive permission queries. Best-effort — a
     * failing injection never blocks browsing.
     */
    async applyStealth(context) {
        try {
            await context.addInitScript(() => {
                try {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                }
                catch { /* ignore */ }
                try {
                    if (typeof window !== 'undefined' && window.chrome === undefined) {
                        window.chrome = { runtime: {} };
                    }
                }
                catch { /* ignore */ }
                try {
                    const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins');
                    if (desc) {
                        const plugins = desc.get.call(navigator);
                        if (!plugins || plugins.length === 0) {
                            const fill = {
                                item: () => null,
                                namedItem: () => null,
                                refresh: () => { },
                                0: { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
                                1: { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                                2: { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' },
                                3: { name: 'Microsoft Edge PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                                4: { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer' },
                                length: 5,
                            };
                            fill[Symbol.iterator] = () => Object.values(fill).filter((v) => v && typeof v === 'object' && v.name)[Symbol.iterator]();
                            Object.defineProperty(navigator, 'plugins', { get: () => fill });
                        }
                    }
                }
                catch { /* ignore */ }
                try {
                    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
                }
                catch { /* ignore */ }
                try {
                    if (navigator.permissions && navigator.permissions.query) {
                        const original = navigator.permissions.query.bind(navigator.permissions);
                        navigator.permissions.query = (parameters) => {
                            if (parameters && parameters.name === 'notifications') {
                                const state = typeof Notification !== 'undefined' ? Notification.permission : 'denied';
                                return Promise.resolve({ state, onchange: null });
                            }
                            return original(parameters);
                        };
                    }
                }
                catch { /* ignore */ }
            });
        }
        catch (error) {
            console.warn('[dsh-plugin-playwright] stealth init script skipped:', error?.message);
        }
    }
    /** Run one tool body against a shared or throwaway browser view. */
    async run(fn) {
        if (this.config.isolated) {
            await this.ensureStarted();
            const context = await this.requireContext().browser().newContext(this.contextOptions());
            if (this.config.stealth)
                await this.applyStealth(context);
            const buffers = createBuffers();
            attachBuffers(context, buffers);
            const page = context.pages()[0] ?? await context.newPage();
            const handle = new IsolatedHandle(context, page, buffers);
            try {
                return await fn(handle);
            }
            finally {
                await handle.close();
            }
        }
        await this.ensureStarted();
        return fn(this.sharedHandle);
    }
    /** The active page of the shared context (defaulting to the first tab). */
    activePage() {
        const context = this.requireContext();
        const page = this.tabs.get(this.activeTab ?? -1) ?? context.pages()[0];
        if (!page)
            throw new Error('dsh-plugin-playwright: no open page — create one with browser_tab_new or browser_navigate');
        return page;
    }
    registerTab(page) {
        // Idempotent: a page reaches us both through the context 'page' event and
        // through explicit calls (initial page, SharedHandle.newPage).
        for (const [id, candidate] of this.tabs) {
            if (candidate === page)
                return id;
        }
        const id = this.nextTabId++;
        this.tabs.set(id, page);
        this.activeTab = id;
        page.on('close', () => this.dropTab(page));
        return id;
    }
    dropTab(page) {
        for (const [id, candidate] of this.tabs) {
            if (candidate === page)
                this.tabs.delete(id);
        }
        if (this.activeTab !== undefined && !this.tabs.has(this.activeTab)) {
            this.activeTab = this.tabs.keys().next().value;
        }
    }
    activateTab(page) {
        for (const [id, candidate] of this.tabs) {
            if (candidate === page) {
                this.activeTab = id;
                return;
            }
        }
        // A page created outside registerTab (isolated/initial) becomes tab 1.
        this.registerTab(page);
    }
    /** Look up a registered tab by id. */
    findTab(id) {
        return this.tabs.get(id);
    }
    get activeTabId() {
        return this.activeTab;
    }
    async listTabs() {
        const result = [];
        for (const [id, page] of this.tabs) {
            result.push({ id, url: page.url(), title: await page.title() });
        }
        return result;
    }
    consoleEntries() {
        return this.buffers.console;
    }
    networkEntries() {
        return this.buffers.network;
    }
    requireContext() {
        if (!this.context)
            throw new Error('dsh-plugin-playwright: browser is not started');
        return this.context;
    }
    /** Close the browser and all contexts; idempotent. */
    async close() {
        if (!this.started)
            return;
        this.started = false;
        this.tabs.clear();
        this.activeTab = undefined;
        if (this.context !== undefined) {
            await this.context.close().catch(() => { });
            this.context = undefined;
        }
        if (this.browser !== undefined) {
            await this.browser.close().catch(() => { });
            this.browser = undefined;
        }
    }
}
