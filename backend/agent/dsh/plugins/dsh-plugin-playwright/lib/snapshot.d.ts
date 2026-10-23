/**
 * Accessibility snapshot builder for dsh-plugin-playwright.
 *
 * Uses Playwright's `locator.ariaSnapshot({ ref: true })` to obtain the
 * accessibility tree of the current page, parses the resulting YAML into a
 * JSON tree, and records a ref → locator map so action tools (`browser_click`,
 * `browser_type`, …) can target elements by the numeric refs the model saw in
 * the snapshot.
 *
 * @module dsh-plugin-playwright/snapshot
 */
import type { Locator, Page } from 'playwright';
/** One node of the accessibility tree. */
export interface SnapshotNode {
    role: string;
    name?: string;
    /** Numeric ref assigned in DFS order; only interactive nodes are targetable. */
    ref?: number;
    value?: string;
    level?: number;
    checked?: boolean | 'mixed';
    pressed?: boolean;
    expanded?: boolean;
    disabled?: boolean;
    focused?: boolean;
    selected?: boolean;
    multiline?: boolean;
    children?: SnapshotNode[];
}
/** The complete `browser_snapshot`-style result. */
export interface AccessibilitySnapshot {
    page: {
        url: string;
        title: string;
    };
    snapshot: SnapshotNode;
}
/** Ref → locator resolution for the snapshot of one page. */
export type RefMap = Map<number, Locator>;
/** Retrieve the ref map captured by the most recent snapshot of `page`. */
export declare function refsFor(page: Page): RefMap | undefined;
/** Store the ref map for `page` (called by {@link takeAccessibilitySnapshot}). */
export declare function storeRefs(page: Page, refs: RefMap): void;
/**
 * Take an accessibility snapshot of `page` and build the ref → locator map.
 *
 * Ref numbering is sequential in DFS order over the tree; the numeric refs are
 * what action tools resolve `ref` arguments against. The ref map is stored so
 * action tools can target elements named in the latest snapshot.
 */
export declare function takeAccessibilitySnapshot(page: Page): Promise<{
    snapshot: AccessibilitySnapshot;
    refs: RefMap;
}>;
/** Whether a ref-carrying role is a sensible interaction target. */
export declare function isInteractiveRole(role: string): boolean;
