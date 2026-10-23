# AGENTS.md — maintainer & coding-agent guide

This file tells you — whether you're a human maintainer or a coding agent — how this repository is structured and how to extend it without breaking its design.

## Quick orientation

`dsh-plugin-playwright` is a **DeepSeek Harness plugin** that registers a `browser_*` tool family backed by a real Playwright browser. It is an independent implementation, organized by **user intent** rather than as a port of a generic Playwright MCP cover.

| File / dir | Purpose |
|---|---|
| `src/index.ts` | Assembly. Builds a `BrowserSession`, registers every tool, closes the browser on fiber dispose. |
| `src/config.ts` | Configuration schema + defaults (engine, viewport, capabilities, …). |
| `src/browser.ts` | The runtime core: `BrowserSession`, `CallHandle`, `withAbort`. **Treat as a stable contract.** |
| `src/snapshot.ts` | Convert `ariaSnapshot` YAML into a JSON tree + a ref→locator map. **Treat as a stable contract.** |
| `src/tools/` | The tool surface, split into behaviour modules (below). |
| `test/smoke.ts` | End-to-end smoke test that mounts `apply()` and drives a real chromium. |

## The `src/tools/` convention

Tools are grouped by **what the model/agent is trying to do**. A new tool's home is decided by intent:

| Module | Intent | Existing tools |
|---|---|---|
| `navigation.ts` | Move / wait on the page | `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`, `browser_wait_for` |
| `interact.ts` | Mutate the page through elements | `browser_click`, `browser_type`, `browser_type_submit`, `browser_select_option`, `browser_hover`, `browser_focus`, `browser_press_key`, `browser_drag`, `browser_upload_file` |
| `inspect.ts` | Read page state back to the model | `browser_snapshot`, `browser_console_messages`, `browser_network_requests` |
| `control.ts` | Operate the session itself | `browser_tab_new`, `browser_tab_switch`, `browser_tab_close`, `browser_tab_list`, `browser_resize`, `browser_init_script`, `browser_storage_state` |
| `capture.ts` | Produce files | `browser_screenshot`, `browser_pdf`, `browser_tracing_start`, `browser_tracing_stop` |
| `power.ts` | Escape hatches (privileged) | `browser_evaluate` |

Shared scaffolding lives in:

- `src/tools/schema.ts` — value contracts (`stateSchema`, `tabStateSchema`, `fileResultSchema`, `refOrSelector`, `StateValue`).
- `src/tools/util.ts` — cross-cutting helpers used by *more than one* module (`pageState`, `resolveLocator`, `renderStateText`, `textBlock`, `abortable`, `ensureOutputDir`, `timestamp`).
- `src/tools/factory.ts` — `createTools(session, config)` concatenates every module's output in a stable order.

## How to add a new tool

1. **Choose the module.** Put the tool in the behaviour group it belongs to (see table above). If none fits, consider whether it's a new capability group — and whether `config.capabilities` should gate it.
2. **Define it with `defineTool`.** Give it a `browser_*` name, an accurate `description`, `parameters`, an `output.schema` (reference the shared schemas from `./schema.ts`) and an `output.render` (a helpful line of model-facing text).
3. **Body via `session.run`.** Write `execute` as `(args, exec) => session.run(async (handle) => { … })`. Use `handle.activePage()` and the `abortable(exec, …)` wrapper so cancellation works.
4. **Reuse helpers, don't duplicate.** `pageState`, `resolveLocator`, `ensureOutputDir`, `timestamp` etc. belong in `util.ts`. If a helper is only used by your module, keep it local — don't pollute `util.ts`.
5. **Wire it in.** Each module ends with `return tools`; nothing else needs registering because `factory.ts` already concatenates every module.
6. **Add it to `test/smoke.ts`'s `expectedTools`** and, ideally, a behavioural assertion.
7. **Update docs.** Add a row to the catalog in `README.md` and `README.zh.md`.

## Rules & boundaries

- **Do not change `src/browser.ts` or `src/snapshot.ts` casually.** Their public shapes (`BrowserSession`, `CallHandle`, `takeAccessibilitySnapshot`, `refsFor`) are relied upon by every tool and by `test/smoke.ts`. Design changes here need their own review.
- **Do not create cross-module imports between behaviour modules.** If two modules need the same thing, it belongs in `util.ts` / `schema.ts` (shared) — a sibling import is a design smell.
- **Never break the tool contract.** Tool names, parameters, and output values are asserted by `test/smoke.ts` and consumed by the harness. A behavioural change belongs in its own change, not a drive-by edit.
- **Keep values lossless-JSON.** Don't return `undefined`-valued keys; the harness rejects them. Use the existing patterns (spread conditionally, or normalize to `null`).

## Running checks

```bash
pnpm install     # install deps (note: some @deepseek-ai/* deps are private-scoped)
pnpm typecheck   # `tsc -p tsconfig.json` over src + test
pnpm smoke       # mount the plugin and drive a real headless chromium
```

If `pnpm install` can't resolve the private `@deepseek-ai/*` packages, you can still type-check using a workspace/dev environment that has them; smoke needs a full install plus a downloaded chromium build.

## Development workflow

- Keep changes minimal and focused; prefer small, reviewable diffs.
- Run `pnpm typecheck` and `pnpm smoke` before claiming a change is done.
- When a change touches the public tool contract or the session model, write/adjust an OpenSpec change under `openspec/changes/` before/with the implementation.