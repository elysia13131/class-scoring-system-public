/**
 * Shared value contracts for dsh-plugin-playwright tools.
 *
 * Every state-bearing tool returns a canonical JSON value that the harness
 * validates with its lossless-JSON check. These schemas define the shape of
 * those values and are reused across the behaviour modules so the tool surface
 * stays consistent.
 *
 * @module dsh-plugin-playwright/tools/schema
 */
/** The canonical value every page-state tool returns. */
export const stateSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true },
        url: { type: 'string', required: true },
        title: { type: 'string', required: true },
        snapshot: { type: 'json' },
    },
};
/** Canonical value with a numeric tab id (tab tools). */
export const tabStateSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true },
        tabId: { type: 'number' },
        url: { type: 'string' },
        title: { type: 'string' },
        snapshot: { type: 'json' },
        tabs: { type: 'array', items: { type: 'json' } },
    },
};
/** Canonical value for file-producing tools (screenshot/pdf/trace). */
export const fileResultSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true },
        path: { type: 'string', required: true },
        url: { type: 'string', required: true },
        title: { type: 'string', required: true },
        width: { type: 'number' },
        height: { type: 'number' },
    },
};
/** Shared ref-or-selector parameter pair (a sibling of the snapshot's refs). */
export const refOrSelector = {
    ref: { type: 'number', description: 'Element ref from the latest browser_snapshot' },
    selector: { type: 'string', description: 'CSS selector as an alternative to ref' },
    frame: { type: 'string', description: 'Iframe target: a substring of the iframe url or its frame name. Elements inside a cross-origin login iframe are NOT reachable from the main frame — resolve them with frame/frameIndex (list frames via browser_frame_list, read the iframe with browser_snapshot frame=…)' },
    frameIndex: { type: 'number', description: 'Iframe target as the numeric index from browser_frame_list (0 = main frame); an alternative to frame' },
};
/** Frame targeting only (for tools that snapshot frames, without ref/selector). */
export const frameTarget = {
    frame: refOrSelector.frame,
    frameIndex: refOrSelector.frameIndex,
};
/** Shared coordinate-click parameters (viewport CSS pixels, same space as screenshots). */
export const coordinateClickParams = {
    x: { type: 'number', required: true, description: 'Viewport CSS-pixel X — same coordinate space as browser_screenshot; element centers come from browser_element_box' },
    y: { type: 'number', required: true, description: 'Viewport CSS-pixel Y' },
    button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; defaults to left' },
    clickCount: { type: 'number', description: 'Click count; defaults to 1 (2 = double click)' },
    modifiers: {
        type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
        description: 'Keyboard modifiers held during the click',
    },
    steps: { type: 'number', description: 'Mouse path segments for the move; higher looks more human; defaults to 12' },
    delayMs: { type: 'number', description: 'Press duration between mouse down and up; defaults to 40' },
    jitter: { type: 'boolean', description: 'Randomize the landing point by up to ±2px; defaults to true' },
};
