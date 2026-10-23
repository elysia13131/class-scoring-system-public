/**
 * Cross-cutting helpers shared by every behaviour module.
 *
 * These utilities are used by more than one tool group (e.g. `pageState` is
 * called by navigation, interaction and state tools alike), so they are kept
 * here rather than inside a single behaviour module where siblings would then
 * import from one another.
 *
 * @module dsh-plugin-playwright/tools/util
 */
import type { Locator } from 'playwright';
import type { CallHandle } from '../browser.ts';
import type { Config } from '../config.ts';
import type { StateValue } from './schema.ts';
/** Build the canonical state value for the active page of a call. */
export declare function pageState(handle: CallHandle, withSnapshot: boolean): Promise<StateValue>;
/** Resolve a `ref`/`selector` argument pair to a live locator. */
export declare function resolveLocator(handle: CallHandle, args: {
    ref?: number;
    selector?: string;
}): Locator;
/** Render model-facing text for a page-state value. */
export declare function renderStateText(value: StateValue, headline?: string): string;
/** Wrap a string into a single text block for an `output.render`. */
export declare function textBlock(text: string): Array<{
    type: 'text';
    text: string;
}>;
/** Wait for an abort signal, rejecting with AbortError. */
export declare function abortable<T>(exec: {
    signal: AbortSignal;
}, promise: Promise<T>): Promise<T>;
/** Ensure the output directory exists and return it. */
export declare function ensureOutputDir(config: Config): Promise<string>;
/** A filesystem-safe timestamp for generated file names. */
export declare function timestamp(): string;
