/**
 * Interaction behaviour — mutating the page through its elements.
 *
 * These tools act on a target element (referenced by snp ref or CSS selector)
 * and return the resulting page state. They are the "hands" of the plugin,
 * contrasting with the read-only `inspect` tools and the session-level
 * `control` tools.
 *
 * Fork additions:
 * - every ref/selector tool accepts `frame`/`frameIndex`, so elements inside a
 *   cross-origin iframe (e.g. an embedded login dialog) can be operated on;
 * - `browser_click_at` performs a humanised viewport-coordinate click
 *   (`page.mouse`), which works across frames, shadow DOM, canvases and
 *   overlay-obscured targets that no selector can reach.
 *
 * @module dsh-plugin-playwright/tools/interact
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { coordinateClickParams, refOrSelector, stateSchema } from './schema.js';
import { abortable, jitterPoint, pageState, renderStateText, resolveLocator, sleep, textBlock } from './util.js';
/** Quadratic bezier path samples (human-like drag trajectories). */
function bezierPath(x0, y0, x1, y1, x2, y2, steps) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const a = (1 - t) * (1 - t);
        const b = 2 * (1 - t) * t;
        const c = t * t;
        pts.push({ x: a * x0 + b * x1 + c * x2, y: a * y0 + b * y1 + c * y2 });
    }
    return pts;
}
/** Build every interaction tool for one plugin instance. */
export function createInteractionTools(session, config) {
    const withSnapshot = config.capabilities.accessibility;
    const timeout = config.timeoutMs;
    const tools = [];
    tools.push(defineTool({
        name: 'browser_click',
        description: 'Click an element, referenced by ref (from the latest browser_snapshot) or a CSS selector. For elements inside an iframe (e.g. a cross-origin login dialog) pass frame/frameIndex.',
        parameters: {
            ...refOrSelector,
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; defaults to left' },
            modifiers: {
                type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
                description: 'Keyboard modifiers held during the click',
            },
            clickCount: { type: 'number', description: 'Click count; defaults to 1' },
        },
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, 'clicked')) },
        execute: async ({ ref, selector, frame, frameIndex, button, modifiers, clickCount }, exec) => session.run(async (handle) => {
            const locator = resolveLocator(handle, { ref, selector, frame, frameIndex });
            await abortable(exec, locator.click({ button: button ?? 'left', modifiers, clickCount: clickCount ?? 1, timeout }));
            return pageState(handle, withSnapshot);
        }),
    }));
    tools.push(defineTool({
        name: 'browser_type',
        description: 'Type text into an input/textarea (clearing existing content by default). Works inside an iframe too: pass frame/frameIndex alongside ref/selector.',
        parameters: {
            ...refOrSelector,
            text: { type: 'string', required: true, description: 'Text to type' },
            clear: { type: 'boolean', description: 'Clear existing content first; defaults to true' },
        },
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, 'typed')) },
        execute: async ({ ref, selector, frame, frameIndex, text, clear }, exec) => session.run(async (handle) => {
            const locator = resolveLocator(handle, { ref, selector, frame, frameIndex });
            if (clear !== false) {
                await abortable(exec, locator.fill(text));
            }
            else {
                await abortable(exec, locator.pressSequentially(text, { delay: 0 }));
            }
            return pageState(handle, withSnapshot);
        }),
    }));
    tools.push(defineTool({
        name: 'browser_type_submit',
        description: 'Type text into an input/textarea and press Enter (useful for search boxes and forms). Works inside an iframe too.',
        parameters: {
            ...refOrSelector,
            text: { type: 'string', required: true, description: 'Text to type' },
        },
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, 'typed and submitted')) },
        execute: async ({ ref, selector, frame, frameIndex, text }, exec) => session.run(async (handle) => {
            const locator = resolveLocator(handle, { ref, selector, frame, frameIndex });
            await abortable(exec, locator.fill(text));
            await abortable(exec, locator.press('Enter'));
            return pageState(handle, withSnapshot);
        }),
    }));
    tools.push(defineTool({
        name: 'browser_select_option',
        description: 'Select one or more options in a <select> element by value or label. Works inside an iframe too.',
        parameters: {
            ...refOrSelector,
            options: { type: 'array', items: { type: 'string' }, required: true, description: 'Option values (or labels) to select' },
        },
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, 'selected options')) },
        execute: async ({ ref, selector, frame, frameIndex, options }, exec) => session.run(async (handle) => {
            const locator = resolveLocator(handle, { ref, selector, frame, frameIndex });
            await abortable(exec, locator.selectOption(options));
            return pageState(handle, withSnapshot);
        }),
    }));
    tools.push(defineTool({
        name: 'browser_hover',
        description: 'Hover the mouse over an element. Works inside an iframe too.',
        parameters: { ...refOrSelector },
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, 'hovered')) },
        execute: async ({ ref, selector, frame, frameIndex }, exec) => session.run(async (handle) => {
            const locator = resolveLocator(handle, { ref, selector, frame, frameIndex });
            await abortable(exec, locator.hover({ timeout }));
            return pageState(handle, withSnapshot);
        }),
    }));
    tools.push(defineTool({
        name: 'browser_focus',
        description: 'Focus an element. Works inside an iframe too.',
        parameters: { ...refOrSelector },
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, 'focused')) },
        execute: async ({ ref, selector, frame, frameIndex }, exec) => session.run(async (handle) => {
            const locator = resolveLocator(handle, { ref, selector, frame, frameIndex });
            await abortable(exec, locator.focus());
            return pageState(handle, withSnapshot);
        }),
    }));
    tools.push(defineTool({
        name: 'browser_press_key',
        description: 'Press a key or shortcut (e.g. "Enter", "Control+A") on an element or the page. Works inside an iframe when ref/selector+frame is given.',
        parameters: {
            ...refOrSelector,
            key: { type: 'string', required: true, description: 'Key name or shortcut, e.g. Enter, Tab, Control+A' },
        },
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, 'pressed key')) },
        execute: async ({ ref, selector, frame, frameIndex, key }, exec) => session.run(async (handle) => {
            const page = handle.activePage();
            if (ref !== undefined || selector !== undefined) {
                const locator = resolveLocator(handle, { ref, selector, frame, frameIndex });
                await abortable(exec, locator.press(key));
            }
            else {
                await abortable(exec, page.keyboard.press(key));
            }
            return pageState(handle, withSnapshot);
        }),
    }));
    tools.push(defineTool({
        name: 'browser_drag',
        description: 'Drag an element onto another element.',
        parameters: {
            fromRef: { type: 'number', description: 'Ref of the element to drag' },
            fromSelector: { type: 'string', description: 'CSS selector of the element to drag' },
            toRef: { type: 'number', description: 'Ref of the drop target' },
            toSelector: { type: 'string', description: 'CSS selector of the drop target' },
        },
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, 'dragged')) },
        execute: async ({ fromRef, fromSelector, toRef, toSelector }, exec) => session.run(async (handle) => {
            if ((fromRef === undefined && fromSelector === undefined) || (toRef === undefined && toSelector === undefined)) {
                throw new Error('browser_drag requires a source (fromRef/fromSelector) and a target (toRef/toSelector)');
            }
            const source = resolveLocator(handle, { ref: fromRef, selector: fromSelector });
            const target = resolveLocator(handle, { ref: toRef, selector: toSelector });
            await abortable(exec, source.dragTo(target));
            return pageState(handle, withSnapshot);
        }),
    }));
    tools.push(defineTool({
        name: 'browser_upload_file',
        description: 'Upload files through an <input type="file"> element (use a CSS selector for the input). Works inside an iframe too.',
        parameters: {
            ...refOrSelector,
            files: { type: 'array', items: { type: 'string' }, required: true, description: 'Absolute paths of the files to upload' },
        },
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, 'uploaded files')) },
        execute: async ({ ref, selector, frame, frameIndex, files }, exec) => session.run(async (handle) => {
            const locator = resolveLocator(handle, { ref, selector, frame, frameIndex });
            await abortable(exec, locator.setInputFiles(files));
            return pageState(handle, withSnapshot);
        }),
    }));
    tools.push(defineTool({
        name: 'browser_click_at',
        description: 'Click at viewport CSS-pixel coordinates (x, y). Use when a target cannot be reached by ref/selector at all: inside a cross-origin iframe, canvas/slider surfaces, or overlay-obscured elements. Coordinates share the same space as browser_screenshot; element centers come from browser_element_box. The pointer moves in segments with a jittered landing point to look human (anti-bot).',
        parameters: { ...coordinateClickParams },
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, `clicked at (${_args.x}, ${_args.y})`)) },
        execute: async ({ x, y, button, clickCount, steps, delayMs, jitter, modifiers }, exec) => session.run(async (handle) => {
            const page = handle.activePage();
            const point = jitter === false ? { x, y } : jitterPoint(x, y);
            const mods = modifiers ?? [];
            const presses = clickCount ?? 1;
            // Segmented pointer move + human micro-pause before the press.
            await abortable(exec, page.mouse.move(point.x, point.y, { steps: steps ?? 12 }));
            await sleep(60 + Math.random() * 160, exec);
            for (const mod of mods)
                await abortable(exec, page.keyboard.down(mod));
            for (let i = 0; i < presses; i++) {
                await abortable(exec, page.mouse.down({ button: button ?? 'left' }));
                await sleep((delayMs ?? 40) + Math.random() * 40, exec);
                await abortable(exec, page.mouse.up({ button: button ?? 'left' }));
                if (i < presses - 1)
                    await sleep(50 + Math.random() * 80, exec);
            }
            for (const mod of mods)
                await abortable(exec, page.keyboard.up(mod));
            return pageState(handle, withSnapshot);
        }),
    }));
    tools.push(defineTool({
        name: 'browser_drag_at',
        description: 'Hold the mouse at viewport coordinate (x1,y1) and drag to (x2,y2). For canvas controls that ignore ref/selector: puzzle/captcha sliders, map panning, drag-and-drop surfaces. Generates a human-like drag (anti-bot): slightly curved bezier path, uneven per-segment pacing, jittered grab point; lands exactly on (x2,y2).',
        parameters: {
            x1: { type: 'number', required: true, description: 'Start viewport CSS-pixel X (the grab point, e.g. slider thumb center)' },
            y1: { type: 'number', required: true, description: 'Start viewport CSS-pixel Y' },
            x2: { type: 'number', required: true, description: 'End viewport CSS-pixel X (release point)' },
            y2: { type: 'number', required: true, description: 'End viewport CSS-pixel Y' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; defaults to left' },
            steps: { type: 'number', description: 'Path samples; higher = smoother and slower; defaults to 48 (~0.5-1.2s drag)' },
            jitter: { type: 'boolean', description: 'Randomize the grab point by up to ±2px; defaults to true' },
        },
        output: { schema: stateSchema, render: (_args, value) => textBlock(renderStateText(value, `dragged (${_args.x1},${_args.y1}) → (${_args.x2},${_args.y2})`)) },
        execute: async ({ x1, y1, x2, y2, button, steps, jitter }, exec) => session.run(async (handle) => {
            const page = handle.activePage();
            const grab = jitter === false ? { x: x1, y: y1 } : jitterPoint(x1, y1, 2);
            // Approach the grab point, press, then travel a curved, unevenly paced path.
            await abortable(exec, page.mouse.move(grab.x, grab.y, { steps: Math.max(1, Math.floor((steps ?? 48) * 0.2)) }));
            await sleep(50 + Math.random() * 120, exec);
            await abortable(exec, page.mouse.down({ button: button ?? 'left' }));
            await sleep(40 + Math.random() * 80, exec);
            const n = Math.max(20, steps ?? 48);
            const mx = (grab.x + x2) / 2 + (Math.random() * 2 - 1) * Math.max(4, Math.abs(x2 - grab.x) * 0.05);
            const my = (grab.y + y2) / 2 + (Math.random() * 2 - 1) * Math.max(3, Math.abs(y2 - grab.y) * 0.2);
            const pts = bezierPath(grab.x, grab.y, mx, my, x2, y2, n);
            for (const p of pts) {
                await abortable(exec, page.mouse.move(p.x, p.y, { steps: 1 }));
                await sleep(5 + Math.random() * 18, exec);
            }
            await sleep(60 + Math.random() * 140, exec);
            await abortable(exec, page.mouse.up({ button: button ?? 'left' }));
            return pageState(handle, withSnapshot);
        }),
    }));
    return tools;
}
