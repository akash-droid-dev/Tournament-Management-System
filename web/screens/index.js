/**
 * Screen registry. Each module exports `render(ctx)` and returns a DOM node.
 * The key is the route name used by `go()` and the `#/<screen>` hash.
 */

export * as dashboard from './dashboard.js';
export * as tournament from './tournament.js';
export * as events from './events.js';
export * as entries from './entries.js';
export * as format from './format.js';
export * as draw from './draw.js';
export * as schedule from './schedule.js';
export * as officials from './officials.js';
export * as matches from './matches.js';
export * as approvals from './approvals.js';
export * as standings from './standings.js';
export * as medals from './medals.js';
export * as protests from './protests.js';
export * as reports from './reports.js';
export * as audit from './audit.js';
export * as access from './access.js';
export * as public from './public.js';
