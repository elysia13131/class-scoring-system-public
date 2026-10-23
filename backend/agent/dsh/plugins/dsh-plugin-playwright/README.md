# dsh-plugin-playwright

Playwright browser automation tools for [DeepSeek Harness](https://github.com/deepseek-ai/dsh).

This plugin registers the `browser_*` tool family on the Harness tool registry, launching a real Chromium/Firefox/WebKit browser so an agent can navigate pages, interact with elements, read the accessibility tree, capture files, and manage a session — all through structured tool calls.

> **Design note:** this codebase is written as an independent DSH plugin, organized by *user intent* (navigate / interact / inspect / control / capture / power) rather than by a generic Playwright port. It builds on the browser automation concepts popularised by the wider Playwright tooling ecosystem.

---

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Tool catalog](#tool-catalog)
- [Architecture](#architecture)
- [Development](#development)
- [Differences to note](#differences-to-note)

---

## Install

Add the plugin to a DSH profile and activate it:

```bash
# Add the plugin to the `web` profile (dsh plugin forwards to pnpm in the profile dir)
dsh plugin --profile web add dsh-plugin-playwright
```

Because the browser is a peer of your machine UI, you need a real browser engine. Playwright downloads its own managed builds on first launch (`npx playwright install chromium`); alternatively set `executablePath` to a pre-installed browser (see [Configuration](#configuration)).

## Quick start

After activation, an agent can drive a page like this:

1. **Perceive** — `browser_snapshot` returns the accessibility tree with numeric refs.
2. **Navigate** — `browser_navigate { "url": "https://example.com" }`.
3. **Act** — `browser_click { "ref": 4 }` or `browser_type { "selector": "#q", "text": "hello" }`.
4. **Observe** — `browser_console_messages` / `browser_network_requests`.
5. **Capture** — `browser_screenshot` saves a PNG under the output directory.

The browser is launched lazily on the first tool call and closed when the plugin fiber disposes.

---

## Configuration

Configuration is declared via the schema in `src/config.ts`. The shipped defaults (in `cordis.patch.yml`) are headless and horizontally-scoped. The meaningful knobs:

| Field | Default | Meaning |
|---|---|---|
| `browser` | `chromium` | Engine: `firefox` / `webkit` / `msedge` (msedge ⇒ chromium + msedge channel) |
| `headless` | `true` | No visible window |
| `executablePath` | — | Launch this browser binary instead of Playwright's managed build; overrides `channel` |
| `userDataDir` | — | Persistent profile dir (chromium/msedge only); cookies/localStorage survive restarts |
| `isolated` | `false` | If true, every tool call gets a fresh context closed at call end (no state between calls) |
| `viewport` | `1280×720` | Initial viewport |
| `device` / `locale` / `timezoneId` / `colorScheme` | — | Device descriptor, locale, IANA timezone, color scheme |
| `outputDir` | `.dsh/playwright` | Where screenshots / PDFs / traces are written |
| `timeoutMs` | `30000` | Default per-action timeout |
| `navigationWaitUntil` | `load` | Default wait condition for navigation |
| `capabilities` | see below | Per-capability toggles |
| `evaluate` | `false` | Enables the `browser_evaluate` escape hatch (off by default) |

### Capabilities

Gate whole tools or strip data from results:

```yaml
capabilities:
  accessibility: true   # attach a snapshot to state-bearing results
  screenshot: true      # register browser_screenshot
  pdf: true             # register browser_pdf (chromium/msedge)
  network: true         # register browser_network_requests + capture network
  tracing: false        # register browser_tracing_start/stop
  storageState: false   # register browser_storage_state + browser_init_script
```

---

## Tool catalog

Tools are organized into behaviour modules (see [Architecture](#architecture)). All tool names, parameters and outputs are stable contracts.

### navigation — moving / waiting on a page

| Tool | What it does |
|---|---|
| `browser_navigate` | Load a URL and wait; returns URL + title + snapshot |
| `browser_back` / `browser_forward` | History navigation |
| `browser_reload` | Reload the active page |
| `browser_wait_for` | Wait for a CSS selector to reach a state |

### interact — mutating the page

| Tool | What it does |
|---|---|
| `browser_click` | Click by element ref or CSS selector (supports button/modifiers/count) |
| `browser_type` | Fill an input/textarea (clear-by-default), or type without clearing |
| `browser_type_submit` | Type then press Enter (forms, search boxes) |
| `browser_select_option` | Select `<select>` options by value/label |
| `browser_hover` / `browser_focus` | Hover / focus an element |
| `browser_press_key` | Press a key or shortcut on an element or the page |
| `browser_drag` | Drag one element onto another |
| `browser_upload_file` | Set files on an `<input type=file>` |

### inspect — reading the page state

| Tool | What it does |
|---|---|
| `browser_snapshot` | Accessibility tree with numeric refs for interactive elements |
| `browser_console_messages` | Captured console messages (ring buffer) |
| `browser_network_requests` | Captured request/response entries, filterable by URL/method/status |

### control — operating the session

| Tool | What it does |
|---|---|
| `browser_tab_new` / `browser_tab_switch` / `browser_tab_close` / `browser_tab_list` | Tab lifecycle |
| `browser_resize` | Resize the active viewport |
| `browser_init_script` *(capability)* | Register a script that runs on every future page load |
| `browser_storage_state` *(capability)* | Return cookies + localStorage of the shared context |

### capture — producing files

| Tool | What it does |
|---|---|
| `browser_screenshot` *(capability)* | Save a screenshot under the output directory |
| `browser_pdf` *(capability)* | Print to PDF (chromium/msedge) |
| `browser_tracing_start` / `browser_tracing_stop` *(capability)* | Start/stop capture and write a trace zip |

### power — the escape hatch

| Tool | What it does |
|---|---|
| `browser_evaluate` *(config `evaluate`)* | Evaluate arbitrary JS in the page (reads and writes; disabled by default) |

---

## Architecture

```
src/
├── index.ts          Assembly: register tools + own the browser lifecycle
├── config.ts         Configuration schema + defaults
├── browser.ts        BrowserSession, CallHandle, withAbort (lazy start, shared/isolated)
├── snapshot.ts       ariaSnapshot → JSON tree + ref→locator map
└── tools/
    ├── schema.ts     Shared value contracts (state / tab / file results)
    ├── util.ts       Cross-cutting helpers (pageState, resolveLocator, abortable, …)
    ├── factory.ts     createTools(session, config) — assembles all behaviour modules
    ├── navigation.ts / interact.ts / inspect.ts / control.ts / capture.ts / power.ts
    └── ...            each module owns one behaviour group (see catalog above)
```

Every tool configures an `execute(body)` that runs through `session.run`, which resolves a `CallHandle` — the shared persistent context by default, or a throwaway per-call context in `isolated` mode. Cancellation (`AbortSignal`) is bridged into Playwright operations via `withAbort`.

---

## Development

```bash
pnpm install        # install dependencies
pnpm typecheck      # run tsc over src + test
pnpm smoke          # mount the plugin and drive a real headless chromium
```

See [`AGENTS.md`](./AGENTS.md) for the maintainer's map of the codebase and the convention for adding tools.

---

## Differences to note

This plugin is an independent DSH implementation. Notable design choices:

- **Organised by user intent.** Files are grouped into *navigation / interact / inspect / control / capture / power* rather than around a serialised upstream API surface.
- **Session model.** One plugin instance owns one lazily-started shared browser; `isolated` gives per-call transparency. Shared state survives between calls by default.
- **Cancellation-aware.** Tool operations are abortable via the harness signal, not fire-and-forget.
- **Contract-driven.** Every tool spells out a canonical JSON value plus a separate model-facing `render` projection, validated against the harness's lossless-JSON rules.
- **`browser_evaluate` gated.** The arbitrary-JS escape hatch is off unless you explicitly opt in.