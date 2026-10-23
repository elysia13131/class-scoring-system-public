/**
 * Cross-cutting helpers shared by every behaviour module.
 *
 * These utilities are used by more than one tool group (e.g. `pageState` is
 * called by navigation, interaction and state tools alike), so they are kept
 * here rather than inside a single behaviour module where siblings would then
 * import from one another.
 *
 * This fork extends the resolver with **frame-piercing**: a `frame` (url
 * substring / frame name) or `frameIndex` argument targets an iframe document,
 * so elements inside cross-origin login iframes (unreachable from the main
 * frame) become selectable. Ref maps are stored per owner (page or frame).
 *
 * @module dsh-plugin-playwright/tools/util
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { withAbort } from '../browser.js';
import { refsFor, takeAccessibilitySnapshot } from '../snapshot.js';
/** Build the canonical state value for the active page of a call. */
export async function pageState(handle, withSnapshot) {
    const page = handle.activePage();
    const url = page.url();
    const title = await page.title();
    if (withSnapshot) {
        const { snapshot } = await takeAccessibilitySnapshot(page);
        return { ok: true, url, title, snapshot: snapshot.snapshot };
    }
    return { ok: true, url, title };
}
/**
 * Resolve a `frame`/`frameIndex` argument pair to a live frame of `page`.
 * Returns `undefined` when neither argument is given (main-frame semantics).
 */
export function resolveFrame(page, args) {
    if (args === undefined || (args.frame === undefined && args.frameIndex === undefined)) {
        return undefined;
    }
    const frames = page.frames();
    if (args.frameIndex !== undefined) {
        const byIndex = frames[args.frameIndex];
        if (!byIndex) {
            throw new Error(`no frame at index ${args.frameIndex} — the page has ${frames.length} frame(s); call browser_frame_list to see them`);
        }
        return byIndex;
    }
    const needle = String(args.frame);
    const byUrl = frames.find((frame) => frame.url().includes(needle));
    if (byUrl)
        return byUrl;
    const byName = frames.find((frame) => (frame.name() ?? '').includes(needle));
    if (byName)
        return byName;
    throw new Error(`no frame whose url or name contains "${needle}" — call browser_frame_list to see available frames`);
}
/** Describe the element owner (page or a specific frame) for error messages. */
export function ownerDescription(page, frame) {
    return frame === undefined ? page.url() : `iframe ${frame.url()}`;
}
/**
 * Resolve a `ref`/`selector` argument pair (optionally inside `frame`) to a
 * live locator. Selectors resolve against the frame document when a frame is
 * targeted; refs come from the ref map of the owner the snapshot was taken on.
 */
export function resolveLocator(handle, args) {
    const page = handle.activePage();
    const frame = resolveFrame(page, args);
    const owner = frame ?? page;
    if (args.selector !== undefined) {
        return owner.locator(args.selector);
    }
    if (args.ref !== undefined) {
        const refs = refsFor(owner);
        const locator = refs?.get(args.ref);
        if (!locator) {
            throw new Error(`no element with ref ${args.ref} in the latest snapshot of ${ownerDescription(page, frame)} — call browser_snapshot (${frame === undefined ? 'no frame argument' : `frame=… for ${frame.url()}`}) first (the page may have changed) or pass a CSS selector instead`);
        }
        return locator;
    }
    throw new Error('pass either "ref" (from the latest browser_snapshot) or "selector"');
}
/** Render model-facing text for a page-state value. */
export function renderStateText(value, headline) {
    const lines = [];
    if (headline)
        lines.push(headline);
    lines.push(`url: ${value.url}`);
    lines.push(`title: ${value.title}`);
    if (value.snapshot !== undefined) {
        lines.push('accessibility snapshot:');
        lines.push(JSON.stringify(value.snapshot, null, 2));
    }
    return lines.join('\n');
}
/** Wrap a string into a single text block for an `output.render`. */
export function textBlock(text) {
    return [{ type: 'text', text }];
}
/** Wait for an abort signal, rejecting with AbortError. */
export function abortable(exec, promise) {
    return withAbort(exec.signal, promise);
}
/** Ensure the output directory exists and return it. */
export async function ensureOutputDir(config) {
    const dir = path.resolve(config.outputDir);
    await mkdir(dir, { recursive: true });
    return dir;
}
/** A filesystem-safe timestamp for generated file names. */
export function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}
/** Sleep for `ms` (abortable when an exec signal is supplied). */
export function sleep(ms, exec) {
    const promise = new Promise((resolve) => setTimeout(resolve, ms));
    return exec ? abortable(exec, promise) : promise;
}
/** Randomise a landing point by `amount` px each axis (humanised clicks). */
export function jitterPoint(x, y, amount = 2) {
    return {
        x: x + (Math.random() * 2 - 1) * amount,
        y: y + (Math.random() * 2 - 1) * amount,
    };
}
