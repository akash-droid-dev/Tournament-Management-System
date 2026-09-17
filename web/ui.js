/**
 * Shared render helpers.
 *
 * Deliberately tiny: `el` builds DOM, the rest are formatters and a handful of
 * repeated compositions (status badges, gate checklists, tables). Anything that
 * looks like a component lives in the screen that owns it.
 */

/** Build an element. Children may be nodes, strings, arrays, or falsy. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false || c === '') continue;
    if (Array.isArray(c)) append(node, c);
    else node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function frag(children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

// ── Formatters ────────────────────────────────────────────────────────────

export const fmtDate = (d) =>
  d ? new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '—';

export const fmtDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

export const fmtClock = (secs) =>
  `${String(Math.floor((secs ?? 0) / 60)).padStart(2, '0')}:${String((secs ?? 0) % 60).padStart(2, '0')}`;

// ── Status presentation ───────────────────────────────────────────────────

/**
 * Status → badge tone. Colour is never the only signal: every badge also
 * carries its own text, and tables add a left rule for flagged rows.
 */
const TONE = {
  // Tournament
  Draft: 'neutral', Configured: 'info', 'Entries Open': 'info', 'Entries Locked': 'warn',
  'Draw Published': 'pub', Active: 'ok', Completed: 'ok', Archived: 'neutral', Cancelled: 'danger',
  // Match
  Scheduled: 'info', 'Check-in': 'warn', Live: 'live', Suspended: 'warn',
  'Completed (Provisional)': 'warn', Postponed: 'warn', Walkover: 'neutral',
  Abandoned: 'danger', Disqualified: 'danger',
  // Result
  Pending: 'neutral', Entered: 'warn', Verified: 'info', 'Under Protest': 'danger',
  Approved: 'ok', 'Correction in Progress': 'warn', 'Re-verified': 'info',
  // Draw / schedule / approval
  'Not Generated': 'neutral', 'Draft Draw': 'warn', Validated: 'info', Published: 'pub',
  Amended: 'warn', Final: 'ok', Submitted: 'warn', 'Under Review': 'warn',
  Rejected: 'danger', 'Sent Back for Correction': 'warn',
  // Entry
  Confirmed: 'ok', Blocked: 'danger', Scratched: 'neutral', Withdrawn: 'neutral',
  // Event
  'Format Approved': 'info', 'In Progress': 'ok',
  'Cancelled – Insufficient Entries': 'danger',
  // Protest
  Filed: 'warn', Upheld: 'danger',
  // Public-facing labels
  Final: 'ok', 'Awaiting result': 'warn',
  // Officials
  assigned: 'info', acknowledged: 'ok', completed: 'ok', replaced: 'neutral',
  pass: 'ok', fail: 'danger', waived: 'warn', 'not-applicable': 'neutral',
};

export function badge(status, extraClass = '') {
  const tone = TONE[status] ?? 'neutral';
  return el('span', { class: `badge badge-${tone} ${extraClass}`.trim() }, String(status ?? '—'));
}

export function plainBadge(text, tone = 'neutral') {
  return el('span', { class: `badge badge-${tone} badge-plain` }, text);
}

// ── Compositions ──────────────────────────────────────────────────────────

export function pageHead(title, sub, spec) {
  return el('div', { class: 'page-head' }, [
    el('h1', { class: 'page-title' }, [title, spec ? el('span', { class: 'spec-ref' }, spec) : null]),
    sub ? el('p', { class: 'page-sub' }, sub) : null,
  ]);
}

export function card(title, body, { note, actions, flush } = {}) {
  return el('section', { class: 'card' }, [
    title || note || actions
      ? el('div', { class: 'card-head' }, [
          el('div', {}, [
            title ? el('h2', { class: 'card-title' }, title) : null,
            note ? el('p', { class: 'card-note' }, note) : null,
          ]),
          actions ? el('div', { class: 'btn-row' }, actions) : null,
        ])
      : null,
    el('div', { class: `card-body${flush ? ' flush' : ''}` }, body),
  ]);
}

export function tile(label, value, meta, mod = '') {
  return el('div', { class: `tile ${mod}`.trim() }, [
    el('p', { class: 'tile-label' }, label),
    el('div', { class: 'tile-value' }, String(value)),
    meta ? el('div', { class: 'tile-meta' }, meta) : null,
  ]);
}

export function notice(tone, title, body) {
  const icon = { ok: '✓', warn: '!', danger: '✕', info: 'i' }[tone] ?? 'i';
  return el('div', { class: `notice notice-${tone}` }, [
    el('span', { class: 'notice-icon' }, icon),
    el('div', { class: 'notice-body' }, [
      title ? el('p', {}, el('strong', {}, title)) : null,
      Array.isArray(body)
        ? el('ul', {}, body.map((b) => el('li', {}, b)))
        : body ? el('p', {}, body) : null,
    ]),
  ]);
}

export function empty(title, detail) {
  return el('div', { class: 'empty' }, [el('strong', {}, title), detail ? el('span', {}, detail) : null]);
}

/** A §4 phase gate as a checklist, so a blocked action explains itself. */
export function gateList(gate) {
  if (!gate) return null;
  return el('ul', { class: 'gate' }, [
    ...gate.blockers.map((b) =>
      el('li', { class: 'gate-fail' }, [el('span', { class: 'gate-mark' }, '✕'), el('span', {}, b)]),
    ),
    ...gate.satisfied.map((s) =>
      el('li', { class: 'gate-pass' }, [el('span', { class: 'gate-mark' }, '✓'), el('span', {}, s)]),
    ),
  ]);
}

/** Data table. `cols` entries: {key, label, num, mono, render}. */
export function table(cols, rows, { rowClass, emptyText = 'Nothing to show' } = {}) {
  if (!rows.length) return empty(emptyText);
  return el('div', { class: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: c.num ? 'num' : '' }, c.label)))),
      el(
        'tbody',
        {},
        rows.map((r) =>
          el(
            'tr',
            { class: rowClass ? rowClass(r) ?? '' : '' },
            cols.map((c) => {
              const cls = [c.num ? 'num' : '', c.mono ? 'mono' : ''].filter(Boolean).join(' ');
              const v = c.render ? c.render(r) : r[c.key];
              return el('td', { class: cls }, v === undefined || v === null || v === '' ? '—' : v);
            }),
          ),
        ),
      ),
    ]),
  ]);
}

export function field(label, control, hint) {
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-label' }, label),
    control,
    hint ? el('span', { class: 'field-hint' }, hint) : null,
  ]);
}

export function select(options, { value, onchange, id } = {}) {
  const s = el('select', { id }, options.map((o) =>
    el('option', { value: o.value, ...(o.value === value ? { selected: '' } : {}) }, o.label),
  ));
  if (onchange) s.addEventListener('change', () => onchange(s.value));
  return s;
}

export function input(attrs = {}) {
  return el('input', attrs);
}

export function textarea(attrs = {}) {
  return el('textarea', attrs);
}

// ── Toast + modal ─────────────────────────────────────────────────────────

export function toast(message, tone = '', ms = 4200) {
  const node = el('div', { class: `toast${tone ? ` toast-${tone}` : ''}` }, message);
  document.getElementById('toasts').append(node);
  setTimeout(() => node.remove(), ms);
}

/**
 * Prompt for the fields an action needs. Used wherever the domain demands a
 * reason code, so the requirement is visible at the point of action rather
 * than arriving as a rejection.
 */
export function prompt({ title, fields, confirmLabel = 'Confirm' }) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('modal');
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-ok').textContent = confirmLabel;
    const controls = {};
    const body = document.getElementById('modal-body');
    body.replaceChildren(
      el(
        'div',
        { class: 'grid', style: 'gap:12px' },
        fields.map((f) => {
          let control;
          if (f.type === 'select') control = select(f.options, { value: f.value });
          else if (f.type === 'textarea') control = textarea({ ...(f.value ? { value: f.value } : {}) });
          else control = input({ type: f.type ?? 'text', value: f.value ?? '' });
          if (f.required) control.setAttribute('required', '');
          controls[f.name] = control;
          return field(f.label, control, f.hint);
        }),
      ),
    );
    const form = document.getElementById('modal-form');
    const onClose = () => {
      form.removeEventListener('submit', onSubmit);
      resolve(dialog.returnValue === 'ok' ? Object.fromEntries(Object.entries(controls).map(([k, c]) => [k, c.value])) : null);
    };
    const onSubmit = (e) => {
      // The dialog's own value handling closes it; nothing more to do here.
      void e;
    };
    form.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', onClose, { once: true });
    dialog.showModal();
  });
}


/**
 * Show a generated document in the modal.
 *
 * Not a download. A `<a download>` is inert wherever the page is sandboxed
 * (the Claude artifact viewer blocks page-initiated saves outright), and a
 * button that silently does nothing is worse than no button. Rendering the
 * export in place works on every host, and the reader can still select and
 * copy it. The §5.8 audit entry is written either way, because the export was
 * genuinely built.
 */
export function showDocument({ title, body, kind }) {
  const dialog = document.getElementById('modal');
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-ok').textContent = 'Close';
  const host = document.getElementById('modal-body');

  if (kind === 'html') {
    host.replaceChildren(
      el('iframe', {
        class: 'doc-frame',
        srcdoc: body,
        title,
        // The export is our own HTML, but rendering it inert costs nothing.
        sandbox: '',
      }),
    );
  } else {
    host.replaceChildren(
      el('p', { class: 'card-note' }, 'Select and copy, or use your browser’s print dialog from the printable version.'),
      el('pre', { class: 'doc-text', tabindex: '0' }, body),
    );
  }
  // Nothing to confirm — hide the cancel button for a read-only view.
  const cancel = document.querySelector('#modal-form button[value="cancel"]');
  if (cancel) cancel.hidden = true;
  dialog.addEventListener('close', () => { if (cancel) cancel.hidden = false; }, { once: true });
  dialog.showModal();
}

/** Lookup helper: entry ID → display name, from a list of entries. */
export function nameOf(entries, entryId) {
  return entries.find((e) => e.entryId === entryId)?.participantRef?.displayName ?? entryId ?? '—';
}

/** A match side's label, whether it is an entry, a placeholder or a bye. */
export function sideLabel(side) {
  if (!side) return '—';
  if (side.kind === 'bye') return el('span', { class: 'bracket-side-bye' }, 'BYE');
  if (side.kind === 'entry') return side.displayName;
  return el('span', { class: 'bracket-side-tbd' }, side.displayName);
}
