/**
 * Tool assembly — collects every behaviour module's tools into one surface.
 *
 * This is the single place that builds the full `browser_*` tool set for one
 * plugin instance. Each behaviour module applies its own capability gating, so
 * this factory only concatenates their outputs in a stable order.
 *
 * @module dsh-plugin-playwright/tools/factory
 */
import { createNavigationTools } from './navigation.js';
import { createInteractionTools } from './interact.js';
import { createInspectionTools } from './inspect.js';
import { createControlTools } from './control.js';
import { createCaptureTools } from './capture.js';
import { createPowerTools } from './power.js';
/**
 * Build every registered tool for one plugin instance.
 * @param session - shared browser session (lazy start, per-call isolation).
 * @param config - validated plugin config.
 */
export function createTools(session, config) {
    return [
        ...createNavigationTools(session, config),
        ...createInteractionTools(session, config),
        ...createInspectionTools(session, config),
        ...createControlTools(session, config),
        ...createCaptureTools(session, config),
        ...createPowerTools(session, config),
    ];
}
