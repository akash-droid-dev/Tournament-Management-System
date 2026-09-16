/**
 * Sport bundle. Importing this module registers every sport template shipped
 * with the TMS. Kabaddi is the only sport configured so far; adding another is
 * a new file plus one line here.
 */

import './kabaddi.ts';

export * from './registry.ts';
export { kabaddi, KABADDI_EVENTS, type KabaddiState } from './kabaddi.ts';
