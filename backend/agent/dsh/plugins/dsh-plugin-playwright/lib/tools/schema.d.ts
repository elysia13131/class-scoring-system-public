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
import type { JsonValue } from '@deepseek-ai/dsh-tools';
/** The canonical value every page-state tool returns. */
export declare const stateSchema: {
    readonly type: 'object';
    readonly additionalProperties: false;
    readonly properties: {
        readonly ok: {
            readonly type: 'boolean';
            readonly required: true;
        };
        readonly url: {
            readonly type: 'string';
            readonly required: true;
        };
        readonly title: {
            readonly type: 'string';
            readonly required: true;
        };
        readonly snapshot: {
            readonly type: 'json';
        };
    };
};
/** Canonical value with a numeric tab id (tab tools). */
export declare const tabStateSchema: {
    readonly type: 'object';
    readonly additionalProperties: false;
    readonly properties: {
        readonly ok: {
            readonly type: 'boolean';
            readonly required: true;
        };
        readonly tabId: {
            readonly type: 'number';
        };
        readonly url: {
            readonly type: 'string';
        };
        readonly title: {
            readonly type: 'string';
        };
        readonly snapshot: {
            readonly type: 'json';
        };
        readonly tabs: {
            readonly type: 'array';
            readonly items: {
                readonly type: 'json';
            };
        };
    };
};
/** Canonical value for file-producing tools (screenshot/pdf/trace). */
export declare const fileResultSchema: {
    readonly type: 'object';
    readonly additionalProperties: false;
    readonly properties: {
        readonly ok: {
            readonly type: 'boolean';
            readonly required: true;
        };
        readonly path: {
            readonly type: 'string';
            readonly required: true;
        };
        readonly url: {
            readonly type: 'string';
            readonly required: true;
        };
        readonly title: {
            readonly type: 'string';
            readonly required: true;
        };
        readonly width: {
            readonly type: 'number';
        };
        readonly height: {
            readonly type: 'number';
        };
    };
};
/** Shared ref-or-selector parameter pair (a sibling of the snapshot's refs). */
export declare const refOrSelector: {
    readonly ref: {
        readonly type: 'number';
        readonly description: 'Element ref from the latest browser_snapshot';
    };
    readonly selector: {
        readonly type: 'string';
        readonly description: 'CSS selector as an alternative to ref';
    };
};
/** The in-memory shape of a page-state tool result. */
export type StateValue = {
    ok: boolean;
    url: string;
    title: string;
    snapshot?: JsonValue;
};
