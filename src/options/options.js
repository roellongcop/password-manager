import {
  MSG,
  send,
  el,
  qs,
  qsa,
  copyWithAutoClear,
  applyTheme,
  formatDate,
  relativeDate,
  domainIconLetter,
  tintFor,
  download,
  readFile,
  flashMessage,
} from '../ui/common.js';
import {
  newItem,
  upsertItem,
  deleteItem,
  getItem,
  searchItems,
  sortItems,
  folderNames,
  passwordStrength,
  defaultSettings,
  ITEM_TYPES,
  totpConfig,
  hasTotp,
  TOTP_DEFAULTS,
} from '../lib/vault.js';
import { MATCH_TYPES, registrableDomain } from '../lib/matcher.js';
import { generatePassword, generatePassphrase } from '../lib/generator.js';
import {
  generateTotp,
  parseTotpInput,
  secondsRemaining,
  parseAuthenticatorExport,
} from '../lib/totp.js';
import { decodeImageData } from '../lib/qr.js';
import {
  analyze,
  rowsToItems,
  dedupeAgainst,
  itemsToCsv,
  templateCsv,
  CSV_COLUMNS,
  IGNORED,
} from '../lib/csv.js';

const state = {
  vault: null,
  query: '',
  filter: { kind: 'all', value: '' },
  selectedId: '',
  draft: null,
  page: null, // null | 'settings' | 'transfer' | 'security'
  totpTimer: 0,
};

const notice = qs('#notice');

// ------------------------------------------------------------------ bootstrap

async function boot() {
  wireStatic();
  const status = await send(MSG.STATUS);

  if (!status.initialized) {
    location.replace('../onboarding/onboarding.html');
    return;
  }
  if (status.locked) {
    qs('#gate').classList.remove('hidden');
    qs('#gate-password').focus();
    return;
  }
  await load();
}

async function load() {
  const { vault } = await send(MSG.GET);
  state.vault = vault;
  applyTheme(vault.settings.theme);
  qs('#gate').classList.add('hidden');
  qs('#app').classList.remove('hidden');
  // Now that the panes have a real width, the restored splitter position can be
  // checked against it.
  const width = parseInt(qs('.panes').style.getPropertyValue('--list-width'), 10);
  if (width > 0) applyListWidth(width);
  restoreFromHash();
  render();
}

// Where you are lives in the URL hash, so a refresh (or the reload after locking)
// puts you back on the same item, filter, search and page.
const FILTER_KINDS = ['all', 'favorite', 'type', 'folder'];

function restoreFromHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return;

  // Entry points used by the onboarding page and the popup.
  if (raw === 'restore' || raw === 'welcome') {
    state.page = 'transfer';
    return;
  }
  if (raw === 'newcode') {
    state.draft = newItem('totp');
    return;
  }

  const params = new URLSearchParams(raw);

  const page = params.get('page');
  if (page && PAGES.some((entry) => entry.id === page)) state.page = page;

  const filter = params.get('filter');
  if (filter) {
    const separator = filter.indexOf(':');
    const kind = separator === -1 ? filter : filter.slice(0, separator);
    const value = separator === -1 ? '' : filter.slice(separator + 1);
    if (FILTER_KINDS.includes(kind)) state.filter = { kind, value };
  }

  const query = params.get('q');
  if (query) {
    state.query = query;
    qs('#search').value = query;
  }

  const item = params.get('item');
  // "new-<type>" is what syncHash writes; "new" and "newcode" are the older
  // shapes the popup and other pages still link to.
  const newType =
    item === 'new'
      ? 'login'
      : item === 'newcode'
        ? 'totp'
        : item && item.startsWith('new-') && ITEM_TYPES.includes(item.slice(4))
          ? item.slice(4)
          : '';

  if (newType) {
    state.draft = newItem(newType, {
      folder: state.filter.kind === 'folder' ? state.filter.value : '',
    });
  } else if (item && getItem(state.vault, item)) {
    state.selectedId = item;
    state.draft = structuredClone(getItem(state.vault, item));
  }
}

function syncHash() {
  const params = new URLSearchParams();
  if (state.page) {
    params.set('page', state.page);
  } else {
    if (state.filter.kind !== 'all') {
      params.set(
        'filter',
        state.filter.value ? `${state.filter.kind}:${state.filter.value}` : state.filter.kind,
      );
    }
    if (state.selectedId) params.set('item', state.selectedId);
    else if (state.draft) params.set('item', `new-${state.draft.type}`);
  }
  if (state.query) params.set('q', state.query);

  const next = params.toString();
  // replaceState, not a hash assignment: no history entries, no hashchange loop.
  if (location.hash.replace(/^#/, '') !== next) {
    history.replaceState(null, '', next ? `#${next}` : location.pathname);
  }
}

async function persist() {
  await send(MSG.SAVE, { vault: state.vault });
}

// --------------------------------------------------------------------- render

function render() {
  // Changing filter or search can move the open item out of the list. Leaving its
  // editor up would be showing something that is not on screen any more.
  if (state.selectedId && !visibleItems().some((item) => item.id === state.selectedId)) {
    state.selectedId = '';
    state.draft = null;
  }
  syncHash();
  syncNewButtons();
  renderSidebar();
  const showingPage = Boolean(state.page);
  qs('.panes').classList.toggle('hidden', showingPage);
  qs('#page-pane').classList.toggle('hidden', !showingPage);
  stopTotpTimer();
  if (showingPage) renderPage();
  else {
    renderList();
    renderEditor();
  }
}

// The toolbar buttons start a new item of each type; the one whose form is open
// is lit, so it is clear which kind is being created.
const NEW_BUTTONS = [
  ['#new-login', 'login'],
  ['#new-note', 'note'],
  ['#new-card', 'card'],
  ['#new-code', 'totp'],
];

// "totp" is the stored type; "code" is what the button says.
const TYPE_LABELS = { login: 'login', note: 'note', card: 'card', totp: 'code' };

function syncNewButtons() {
  // Only while creating -- highlighting one of these while an existing item is
  // open would suggest that item is a new one.
  const creating = !state.page && state.draft && !state.selectedId ? state.draft.type : '';
  for (const [selector, type] of NEW_BUTTONS) {
    qs(selector).dataset.active = creating === type ? '1' : '0';
  }
}

const FILTERS = [
  { kind: 'all', label: 'All items' },
  { kind: 'favorite', label: 'Favourites' },
  { kind: 'type', value: 'login', label: 'Logins' },
  { kind: 'type', value: 'note', label: 'Secure notes' },
  { kind: 'type', value: 'card', label: 'Cards' },
  { kind: 'type', value: 'totp', label: 'Authenticator' },
];

const PAGES = [
  { id: 'settings', label: 'Settings' },
  { id: 'transfer', label: 'Import & export' },
  { id: 'security', label: 'Master password' },
];

function renderSidebar() {
  const filters = qs('#filters');
  filters.textContent = '';
  for (const entry of FILTERS) {
    const count = itemsFor(entry).length;
    filters.append(
      el(
        'button',
        {
          dataset: {
            active:
              !state.page && state.filter.kind === entry.kind && state.filter.value === (entry.value || '')
                ? '1'
                : '0',
          },
          onclick: () => {
            state.page = null;
            state.filter = { kind: entry.kind, value: entry.value || '' };
            render();
          },
        },
        [el('span', { text: entry.label }), el('span', { class: 'count', text: String(count) })],
      ),
    );
  }

  const folders = qs('#folders');
  folders.textContent = '';
  const names = folderNames(state.vault);
  if (!names.length) {
    folders.append(el('div', { class: 'small muted', style: 'padding:4px 10px', text: 'No folders yet' }));
  }
  for (const name of names) {
    folders.append(
      el(
        'button',
        {
          dataset: {
            active: !state.page && state.filter.kind === 'folder' && state.filter.value === name ? '1' : '0',
          },
          onclick: () => {
            state.page = null;
            state.filter = { kind: 'folder', value: name };
            render();
          },
        },
        [
          el('span', { text: name, title: name }),
          el('span', {
            class: 'count',
            text: String(state.vault.items.filter((item) => item.folder === name).length),
          }),
        ],
      ),
    );
  }

  const pages = qs('#pages');
  pages.textContent = '';
  for (const page of PAGES) {
    pages.append(
      el('button', {
        text: page.label,
        dataset: { active: state.page === page.id ? '1' : '0' },
        onclick: () => {
          // The item stays open underneath, so coming back lands where you left.
          state.page = page.id;
          render();
        },
      }),
    );
  }
}

function itemsFor(filter = state.filter) {
  const items = state.vault.items;
  if (filter.kind === 'favorite') return items.filter((item) => item.favorite);
  if (filter.kind === 'type') return items.filter((item) => item.type === filter.value);
  if (filter.kind === 'folder') return items.filter((item) => item.folder === filter.value);
  return items;
}

function visibleItems() {
  return sortItems(searchItems(itemsFor(), state.query));
}

function renderList() {
  const pane = qs('#list-pane');
  pane.textContent = '';
  const items = visibleItems();

  if (!items.length) {
    pane.append(
      el('div', { class: 'empty' }, [
        el('p', {
          text: state.vault.items.length
            ? 'Nothing here.'
            : 'Your vault is empty. Add a login or import a CSV.',
        }),
      ]),
    );
    return;
  }

  for (const item of items) {
    pane.append(
      el(
        'button',
        {
          class: 'entry',
          dataset: { active: item.id === state.selectedId ? '1' : '0' },
          onclick: (event) => {
            // The star sits inside the row button rather than being one itself:
            // a button inside a button is invalid markup.
            if (event.target.closest('.star')) {
              toggleFavourite(item.id);
              return;
            }
            selectItem(item.id);
          },
        },
        [
          el('span', {
            class: 'avatar',
            text: domainIconLetter(item),
            style: `background:${tintFor(item.name || item.username || '?')}`,
          }),
          el('span', { class: 'lines' }, [
            el('span', { class: 'name', text: item.name || 'Untitled' }),
            el('span', { class: 'sub', text: subtitleFor(item) }),
          ]),
          hasTotp(item) && item.type !== 'totp'
            ? el('span', { class: 'code-badge', title: 'Has a 2FA code', text: '2FA' })
            : null,
          el('span', {
            class: 'star',
            dataset: { on: item.favorite ? '1' : '0' },
            title: item.favorite ? 'Remove from favourites' : 'Add to favourites',
            text: item.favorite ? '★' : '☆',
          }),
        ],
      ),
    );
  }
}

function subtitleFor(item) {
  if (item.type === 'note') return 'Secure note';
  if (item.type === 'totp') return item.username || 'Authenticator code';
  if (item.type === 'card') {
    const digits = String(item.number || '').replace(/\D/g, '');
    return digits ? `•••• ${digits.slice(-4)}` : 'Payment card';
  }
  return item.username || (item.uris || [])[0]?.uri || 'No username';
}

// Favourite is a single flag, so it saves on the spot rather than waiting for
// the Save button -- and it writes to the stored item, never to a draft that may
// have half-finished edits in it.
async function toggleFavourite(id) {
  const item = getItem(state.vault, id);
  if (!item) return;
  const updated = { ...item, favorite: !item.favorite };
  state.vault = upsertItem(state.vault, updated);
  if (state.draft && state.draft.id === id) state.draft.favorite = updated.favorite;
  await persist();
  render();
}

function selectItem(id) {
  state.selectedId = id;
  state.draft = structuredClone(getItem(state.vault, id));
  render();
}

function startNew(type) {
  state.page = null;
  state.selectedId = '';
  state.draft = newItem(type, {
    folder: state.filter.kind === 'folder' ? state.filter.value : '',
  });
  render();
}

// --------------------------------------------------------------------- editor

function renderEditor() {
  const pane = qs('#editor-pane');
  pane.textContent = '';

  if (!state.draft) {
    pane.append(
      el('div', { class: 'empty' }, [
        el('p', { text: 'Select an item, or create a new one.' }),
      ]),
    );
    return;
  }

  const draft = state.draft;
  const isNew = !getItem(state.vault, draft.id);

  // The form scrolls inside body; the action bar below it is a sibling, so it can
  // never end up floating over a field.
  const body = el('div', { class: 'editor-body' });
  pane.append(body);

  body.append(
    el('div', { class: 'editor-title' }, [
      el('span', {
        class: 'avatar',
        text: domainIconLetter(draft),
        style: `background:${tintFor(draft.name || draft.username || '?')}`,
      }),
      el('h2', {
        text: isNew ? `New ${TYPE_LABELS[draft.type] || draft.type}` : draft.name || 'Untitled',
        title: isNew ? '' : draft.name || '',
      }),
      el('span', { class: 'grow' }),
      el('button', {
        class: 'icon',
        text: draft.favorite ? '★ Favourite' : '☆ Favourite',
        onclick: () => {
          draft.favorite = !draft.favorite;
          renderEditor();
        },
      }),
    ]),
  );

  body.append(textField('Name', draft, 'name', { placeholder: 'GitHub' }));
  body.append(folderField(draft));

  if (draft.type === 'login') {
    body.append(textField('Username or email', draft, 'username', { autocomplete: 'off' }));
    body.append(passwordField(draft));
    body.append(totpField(draft));
    body.append(uriEditor(draft));
    body.append(
      checkboxField(
        'Allow filling on insecure (http) pages',
        draft,
        'allowInsecure',
        'Off by default: anything typed into an http page travels in the clear.',
      ),
    );
  }

  if (draft.type === 'totp') {
    body.append(
      textField('Account', draft, 'username', {
        placeholder: 'you@example.com',
        autocomplete: 'off',
      }),
    );
    body.append(totpField(draft));
    body.append(totpAdvanced(draft));
    body.append(uriEditor(draft, 'Websites (so the code can be filled there)'));
  }

  if (draft.type === 'card') {
    body.append(textField('Cardholder', draft, 'cardholder'));
    body.append(textField('Card number', draft, 'number', { class: 'mono' }));
    body.append(
      el('div', { class: 'row' }, [
        el('div', { class: 'grow' }, [textField('Expiry month', draft, 'expMonth', { placeholder: 'MM' })]),
        el('div', { class: 'grow' }, [textField('Expiry year', draft, 'expYear', { placeholder: 'YYYY' })]),
        el('div', { class: 'grow' }, [textField('Security code', draft, 'cvv')]),
      ]),
    );
    body.append(
      el('p', { class: 'small muted', text: 'Cards are stored and copied by hand. Keyring never types them into a payment form.' }),
    );
  }

  body.append(customFieldsEditor(draft));

  // Monospace, because notes are where multi-line config and keys end up.
  const notes = el('textarea', {
    class: 'mono',
    // overflow-wrap, or a long key sits on one line and scrolls sideways.
    style: 'overflow-wrap:anywhere',
    value: draft.notes || '',
    oninput: (event) => {
      draft.notes = event.target.value;
    },
  });

  body.append(
    el('div', { class: 'field' }, [
      el('div', { class: 'row' }, [
        el('label', { text: 'Notes', style: 'margin:0' }),
        el('span', { class: 'grow' }),
        el('button', {
          class: 'icon',
          text: 'Copy',
          onclick: (event) => copyValue(notes.value, event.currentTarget),
        }),
      ]),
      notes,
    ]),
  );

  if (draft.type === 'login' && (draft.passwordHistory || []).length) {
    body.append(passwordHistory(draft));
  }

  if (!isNew) {
    body.append(
      el('p', { class: 'small muted' }, [
        el('span', { text: `Created ${formatDate(draft.createdAt)} · updated ${relativeDate(draft.updatedAt)}` }),
      ]),
    );
  }

  pane.append(
    el('div', { class: 'editor-actions' }, [
      el('button', { class: 'primary', text: 'Save', onclick: saveDraft }),
      el('button', {
        text: 'Cancel',
        onclick: () => {
          state.draft = state.selectedId ? structuredClone(getItem(state.vault, state.selectedId)) : null;
          render();
        },
      }),
      el('span', { class: 'grow' }),
      isNew
        ? null
        : el('button', { class: 'danger', text: 'Delete', onclick: () => removeItem(draft.id) }),
    ]),
  );
}

function textField(label, target, key, attrs = {}) {
  return el('div', { class: 'field' }, [
    el('label', { text: label }),
    el('input', {
      type: 'text',
      value: target[key] || '',
      ...attrs,
      oninput: (event) => {
        target[key] = event.target.value;
      },
    }),
  ]);
}

function checkboxField(label, target, key, hint) {
  return el('div', { class: 'field' }, [
    el('label', { class: 'row', style: 'font-weight:600' }, [
      el('input', {
        type: 'checkbox',
        style: 'width:auto',
        checked: target[key] ? true : null,
        onchange: (event) => {
          target[key] = event.target.checked;
        },
      }),
      el('span', { text: label }),
    ]),
    hint ? el('p', { class: 'small muted', style: 'margin:4px 0 0', text: hint }) : null,
  ]);
}

function folderField(draft) {
  const names = folderNames(state.vault);
  const input = el('input', {
    type: 'text',
    list: 'folder-options',
    value: draft.folder || '',
    placeholder: 'No folder',
    oninput: (event) => {
      draft.folder = event.target.value;
    },
  });
  const datalist = el(
    'datalist',
    { id: 'folder-options' },
    names.map((name) => el('option', { value: name })),
  );
  return el('div', { class: 'field' }, [el('label', { text: 'Folder' }), input, datalist]);
}

function passwordField(draft) {
  const input = el('input', {
    type: 'password',
    value: draft.password || '',
    autocomplete: 'off',
    class: 'mono',
    oninput: (event) => {
      draft.password = event.target.value;
      updateMeter();
    },
  });

  const meter = el('div', { class: 'meter', style: 'margin-top:6px' }, [el('span')]);
  const label = el('p', { class: 'small muted', style: 'margin:5px 0 0' });

  function updateMeter() {
    const result = passwordStrength(input.value);
    meter.dataset.score = String(result.score);
    meter.firstElementChild.style.width = `${Math.min(100, (result.bits / 110) * 100)}%`;
    label.textContent = input.value ? `${result.label} · about ${result.bits} bits` : '';
  }
  updateMeter();

  // One place decides whether the password is visible, so the button label can
  // never disagree with the field -- generating reveals the result, and the
  // button has to say so.
  const revealButton = el('button', {
    class: 'icon',
    text: 'Show',
    onclick: () => setRevealed(input.type === 'password'),
  });

  function setRevealed(revealed) {
    input.type = revealed ? 'text' : 'password';
    revealButton.textContent = revealed ? 'Hide' : 'Show';
  }

  function fillGenerated(value) {
    input.value = value;
    draft.password = value;
    setRevealed(true);
    updateMeter();
  }

  return el('div', { class: 'field' }, [
    el('label', { text: 'Password' }),
    el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [input]),
      revealButton,
      el('button', {
        class: 'icon',
        text: 'Copy',
        onclick: (event) => copyValue(input.value, event.currentTarget),
      }),
      el('button', {
        class: 'icon',
        text: 'Generate',
        onclick: () => fillGenerated(generatePassword({ length: 20 })),
      }),
      el('button', {
        class: 'icon',
        text: 'Passphrase',
        onclick: () => fillGenerated(generatePassphrase({ words: 5 })),
      }),
    ]),
    meter,
    label,
  ]);
}

function totpField(draft) {
  // The live code, large enough to read off and with its own Copy button --
  // it used to be a line of small grey text that rewrote itself every second.
  let current = '';
  const codeText = el('span', { class: 'code-value mono' });
  const remaining = el('span', { class: 'small muted' });
  const problem = el('span', { class: 'small', style: 'color:var(--danger)' });

  const preview = el('div', { class: 'code-preview', style: 'display:none' }, [
    codeText,
    remaining,
    el('span', { class: 'grow' }),
    problem,
    el('button', {
      class: 'icon',
      text: 'Copy',
      onclick: (event) => {
        if (!current) return;
        copyValue(current, event.currentTarget);
      },
    }),
  ]);

  const input = el('input', {
    type: 'text',
    class: 'mono',
    placeholder: 'Base32 secret or otpauth:// link',
    value: draft.totp || '',
    oninput: (event) => {
      const raw = event.target.value.trim();
      try {
        const parsed = raw ? parseTotpInput(raw) : null;
        draft.totp = parsed ? parsed.secret : '';
        if (parsed && raw.toLowerCase().startsWith('otpauth://')) {
          // A pasted link carries the algorithm, digits and period, and often the
          // issuer and account too. Take all of it, then show the bare secret.
          draft.totpAlgorithm = parsed.algorithm || TOTP_DEFAULTS.algorithm;
          draft.totpDigits = parsed.digits || TOTP_DEFAULTS.digits;
          draft.totpPeriod = parsed.period || TOTP_DEFAULTS.period;
          if (!draft.name && parsed.issuer) draft.name = parsed.issuer;
          if (!draft.username && parsed.account) draft.username = parsed.account;
          event.target.value = parsed.secret;
          renderEditor();
          return;
        }
      } catch {
        draft.totp = raw;
      }
      refreshPreview();
    },
  });

  async function refreshPreview() {
    if (!draft.totp) {
      preview.style.display = 'none';
      current = '';
      return;
    }
    try {
      const config = totpConfig(draft);
      const code = await generateTotp(config);
      current = code;
      preview.style.display = 'flex';
      // Only touch the text when the digits change, so it is not replaced under
      // the pointer once a second.
      const shown = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
      if (codeText.textContent !== shown) codeText.textContent = shown;
      remaining.textContent = `${secondsRemaining(config.period)}s left`;
      problem.textContent = '';
    } catch {
      current = '';
      preview.style.display = 'flex';
      codeText.textContent = '';
      remaining.textContent = '';
      problem.textContent = 'That secret is not valid base32.';
    }
  }
  refreshPreview();
  stopTotpTimer();
  state.totpTimer = setInterval(refreshPreview, 1000);

  // A saved QR image fills the whole thing in, same as pasting the link.
  const imageInput = el('input', {
    type: 'file',
    accept: 'image/*',
    onchange: async (event) => {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        const text = await decodeQrFile(file);
        const parsed = parseTotpInput(text);
        if (!parsed || !parsed.secret) {
          throw new Error('That QR code is not an authenticator code.');
        }
        draft.totp = parsed.secret;
        draft.totpAlgorithm = parsed.algorithm || TOTP_DEFAULTS.algorithm;
        draft.totpDigits = parsed.digits || TOTP_DEFAULTS.digits;
        draft.totpPeriod = parsed.period || TOTP_DEFAULTS.period;
        if (!draft.name && parsed.issuer) draft.name = parsed.issuer;
        if (!draft.username && parsed.account) draft.username = parsed.account;
        flashMessage(notice, `Read the code for ${draft.name || 'this account'}.`, 'ok');
        renderEditor();
      } catch (error) {
        flashMessage(notice, error.message, 'error', 8000);
      }
    },
  });

  return el('div', { class: 'field' }, [
    el('label', { text: 'Authenticator secret (TOTP)' }),
    input,
    preview,
    el('p', {
      class: 'small muted',
      style: 'margin:10px 0 5px',
      text: 'Or read it from a saved QR image:',
    }),
    imageInput,
  ]);
}

// Algorithm, digits and period. Almost every site uses the defaults, so this stays
// folded away until someone needs it.
// Draw an image onto a canvas and read a QR code out of it.
async function decodeQrFile(source) {
  const bitmap = await createImageBitmap(source);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return decodeImageData(imageData);
}

function totpAdvanced(draft) {
  const details = el('details', { class: 'field' });
  details.append(
    el('summary', {
      class: 'small muted',
      style: 'cursor:pointer; margin-bottom:8px',
      text: 'Advanced code settings',
    }),
  );

  const nonDefault =
    (draft.totpAlgorithm && draft.totpAlgorithm !== TOTP_DEFAULTS.algorithm) ||
    (draft.totpDigits && Number(draft.totpDigits) !== TOTP_DEFAULTS.digits) ||
    (draft.totpPeriod && Number(draft.totpPeriod) !== TOTP_DEFAULTS.period);
  if (nonDefault) details.open = true;

  details.append(
    el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [
        el('label', { text: 'Algorithm' }),
        el(
          'select',
          {
            onchange: (event) => {
              draft.totpAlgorithm = event.target.value;
            },
          },
          ['SHA-1', 'SHA-256', 'SHA-512'].map((value) =>
            el('option', {
              value,
              text: value,
              selected: value === (draft.totpAlgorithm || TOTP_DEFAULTS.algorithm) ? true : null,
            }),
          ),
        ),
      ]),
      el('div', { class: 'grow' }, [
        el('label', { text: 'Digits' }),
        el(
          'select',
          {
            onchange: (event) => {
              draft.totpDigits = Number(event.target.value);
            },
          },
          ['6', '7', '8'].map((value) =>
            el('option', {
              value,
              text: value,
              selected: Number(value) === Number(draft.totpDigits || TOTP_DEFAULTS.digits) ? true : null,
            }),
          ),
        ),
      ]),
      el('div', { class: 'grow' }, [
        el('label', { text: 'Period (seconds)' }),
        el('input', {
          type: 'number',
          min: '10',
          max: '120',
          value: String(draft.totpPeriod || TOTP_DEFAULTS.period),
          oninput: (event) => {
            draft.totpPeriod = Number(event.target.value) || TOTP_DEFAULTS.period;
          },
        }),
      ]),
    ]),
    el('p', {
      class: 'small muted',
      style: 'margin:6px 0 0',
      text: 'Leave these alone unless the site told you otherwise. Pasting an otpauth:// link sets them for you.',
    }),
  );
  return details;
}

function uriEditor(draft, label = 'Websites') {
  const list = el('div');

  function draw() {
    list.textContent = '';
    (draft.uris || []).forEach((entry, index) => {
      list.append(
        el('div', { class: 'uri-row' }, [
          el('input', {
            type: 'text',
            class: 'grow',
            value: entry.uri,
            placeholder: 'https://example.com',
            oninput: (event) => {
              entry.uri = event.target.value;
            },
          }),
          el(
            'select',
            {
              onchange: (event) => {
                entry.matchType = event.target.value;
              },
            },
            MATCH_TYPES.map((option) =>
              el('option', {
                value: option.value,
                text: option.label,
                selected: option.value === (entry.matchType || 'domain') ? true : null,
              }),
            ),
          ),
          el('button', {
            class: 'icon',
            text: 'Remove',
            onclick: () => {
              draft.uris.splice(index, 1);
              draw();
            },
          }),
        ]),
      );
    });
  }
  draw();

  return el('div', { class: 'field' }, [
    el('label', { text: label }),
    list,
    el('button', {
      text: 'Add website',
      onclick: () => {
        draft.uris = draft.uris || [];
        draft.uris.push({ uri: '', matchType: 'domain' });
        draw();
      },
    }),
  ]);
}

function customFieldsEditor(draft) {
  const list = el('div');

  function draw() {
    list.textContent = '';
    (draft.customFields || []).forEach((field, index) => {
      list.append(
        el('div', { class: 'custom-row' }, [
          el('input', {
            type: 'text',
            value: field.name,
            placeholder: 'Field name',
            oninput: (event) => {
              field.name = event.target.value;
            },
          }),
          el('input', {
            type: 'text',
            class: 'grow mono',
            value: field.value,
            placeholder: 'Value',
            oninput: (event) => {
              field.value = event.target.value;
            },
          }),
          el('button', {
            class: 'icon',
            text: 'Copy',
            onclick: (event) => copyValue(field.value, event.currentTarget),
          }),
          el('button', {
            class: 'icon',
            text: 'Remove',
            onclick: () => {
              draft.customFields.splice(index, 1);
              draw();
            },
          }),
        ]),
      );
    });
  }
  draw();

  return el('div', { class: 'field' }, [
    el('label', { text: 'Custom fields' }),
    list,
    el('button', {
      text: 'Add field',
      onclick: () => {
        draft.customFields = draft.customFields || [];
        draft.customFields.push({ name: '', value: '', hidden: false });
        draw();
      },
    }),
  ]);
}

function passwordHistory(draft) {
  return el('div', { class: 'field' }, [
    el('label', { text: 'Previous passwords' }),
    el(
      'div',
      { class: 'card' },
      draft.passwordHistory.map((entry) =>
        el('div', { class: 'history-row' }, [
          el('span', { class: 'mono', text: entry.password }),
          el('span', { class: 'muted', text: relativeDate(entry.changedAt) }),
        ]),
      ),
    ),
  ]);
}

async function saveDraft() {
  const draft = state.draft;
  if (!draft) return;
  if (!draft.name.trim()) {
    draft.name =
      (draft.uris || [])[0]?.uri ? registrableDomain(draft.uris[0].uri) || 'Untitled' : 'Untitled';
  }
  draft.uris = (draft.uris || []).filter((entry) => entry.uri.trim());
  draft.customFields = (draft.customFields || []).filter((field) => field.name.trim() || field.value.trim());

  state.vault = upsertItem(state.vault, draft);
  await persist();
  state.selectedId = draft.id;
  state.draft = structuredClone(getItem(state.vault, draft.id));
  flashMessage(notice, 'Saved.', 'ok');
  render();
}

async function removeItem(id) {
  const item = getItem(state.vault, id);
  const confirmed = await askConfirm({
    title: 'Delete this item?',
    body: `"${item?.name || 'This item'}" is removed from the vault permanently. There is no undo.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!confirmed) return;
  state.vault = deleteItem(state.vault, id);
  await persist();
  state.selectedId = '';
  state.draft = null;
  flashMessage(notice, 'Deleted.', 'ok');
  render();
}

async function copyValue(value, button) {
  try {
    await copyWithAutoClear(value, state.vault.settings.clipboardClearSeconds);
    // Never swap textContent on a button built from child elements: it would
    // delete them.
    if (button.firstElementChild) {
      button.dataset.copied = '1';
      setTimeout(() => delete button.dataset.copied, 1200);
      return;
    }
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  } catch {
    flashMessage(notice, 'Could not reach the clipboard.', 'error');
  }
}

function stopTotpTimer() {
  if (state.totpTimer) clearInterval(state.totpTimer);
  state.totpTimer = 0;
}

// Replaces window.confirm/prompt, which an extension page cannot rely on: a
// suppressed dialog returns null and the action then does nothing at all, with no
// way for the user to tell it was refused rather than broken.
// Pass `phrase` to require it to be typed out before the button unlocks.
function askConfirm({ title, body, confirmLabel = 'Continue', danger = false, phrase = '' }) {
  return new Promise((resolve) => {
    const input = phrase
      ? el('input', { type: 'text', placeholder: `Type ${phrase}`, autocomplete: 'off' })
      : null;

    const confirmButton = el('button', {
      class: danger ? 'danger' : 'primary',
      text: confirmLabel,
      disabled: phrase ? true : null,
      onclick: () => close(true),
    });

    if (input) {
      input.addEventListener('input', () => {
        confirmButton.disabled = input.value.trim() !== phrase;
      });
    }

    const overlay = el(
      'div',
      {
        class: 'dialog',
        onclick: (event) => {
          if (event.target === overlay) close(false);
        },
      },
      [
        el('div', { class: 'dialog-card' }, [
          el('h2', { text: title }),
          el('p', { class: 'small muted', text: body }),
          input ? el('div', { class: 'field' }, [input]) : null,
          el('div', { class: 'row' }, [
            el('button', { text: 'Cancel', onclick: () => close(false) }),
            confirmButton,
          ]),
        ]),
      ],
    );

    function onKey(event) {
      if (event.key === 'Escape') close(false);
      if (event.key === 'Enter' && !confirmButton.disabled) close(true);
    }

    function close(result) {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    }

    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    (input || confirmButton).focus();
  });
}

// ---------------------------------------------------------------------- pages

function renderPage() {
  const pane = qs('#page-pane');
  pane.textContent = '';
  if (state.page === 'settings') renderSettings(pane);
  if (state.page === 'transfer') renderTransfer(pane);
  if (state.page === 'security') renderSecurity(pane);
}

function renderSettings(pane) {
  const settings = { ...defaultSettings(), ...state.vault.settings };

  const save = async (patch) => {
    Object.assign(settings, patch);
    state.vault = { ...state.vault, settings: { ...state.vault.settings, ...patch } };
    await persist();
    applyTheme(state.vault.settings.theme);
    flashMessage(notice, 'Settings saved.', 'ok');
  };

  pane.append(
    el('div', { class: 'section' }, [
      el('h2', { text: 'Locking' }),
      selectField(
        'Lock the vault after',
        [
          ['1', '1 minute'],
          ['5', '5 minutes'],
          ['15', '15 minutes'],
          ['30', '30 minutes'],
          ['60', '1 hour'],
          ['0', 'Never while the browser is open'],
        ],
        String(settings.autoLockMinutes),
        (value) => save({ autoLockMinutes: Number(value) }),
      ),
      el('p', { class: 'small muted', text: 'The vault always locks when the browser closes.' }),
    ]),

    el('div', { class: 'section' }, [
      el('h2', { text: 'Clipboard' }),
      selectField(
        'Clear copied passwords after',
        [
          ['30', '30 seconds'],
          ['60', '1 minute'],
          ['120', '2 minutes'],
          ['0', 'Never'],
        ],
        String(settings.clipboardClearSeconds),
        (value) => save({ clipboardClearSeconds: Number(value) }),
      ),
    ]),

    el('div', { class: 'section' }, [
      el('h2', { text: 'On web pages' }),
      toggleRow('Show the Keyring icon inside login fields', settings.showInlineIcon, (value) =>
        save({ showInlineIcon: value }),
      ),
      toggleRow('Offer to save new logins after signing in', settings.offerToSave, (value) =>
        save({ offerToSave: value }),
      ),
      el('p', { class: 'small muted', text: 'Keyring never fills a form on its own; filling always takes a click or the keyboard shortcut.' }),
    ]),

    el('div', { class: 'section' }, [
      el('h2', { text: 'Appearance' }),
      selectField(
        'Theme',
        [
          ['system', 'Match the system'],
          ['light', 'Light'],
          ['dark', 'Dark'],
        ],
        settings.theme,
        (value) => save({ theme: value }),
      ),
    ]),

    el('div', { class: 'section' }, [
      el('h2', { text: 'Sites Keyring ignores' }),
      neverList(settings, save),
    ]),
  );
}

function neverList(settings, save) {
  const wrapper = el('div');
  const domains = settings.neverDomains || [];
  if (!domains.length) {
    wrapper.append(el('p', { class: 'small muted', text: 'None. Choosing "Never here" on a save prompt adds a site.' }));
  }
  for (const domain of domains) {
    wrapper.append(
      el('span', { class: 'chip' }, [
        el('span', { text: domain }),
        el('button', {
          text: '×',
          title: 'Remove',
          onclick: async () => {
            await save({ neverDomains: domains.filter((entry) => entry !== domain) });
            render();
          },
        }),
      ]),
    );
  }
  return wrapper;
}

function selectField(label, options, value, onChange) {
  return el('div', { class: 'field' }, [
    el('label', { text: label }),
    el(
      'select',
      { onchange: (event) => onChange(event.target.value) },
      options.map(([optionValue, optionLabel]) =>
        el('option', {
          value: optionValue,
          text: optionLabel,
          selected: optionValue === value ? true : null,
        }),
      ),
    ),
  ]);
}

function toggleRow(label, checked, onChange) {
  return el('label', { class: 'row', style: 'margin-bottom:10px' }, [
    el('input', {
      type: 'checkbox',
      style: 'width:auto',
      checked: checked ? true : null,
      onchange: (event) => onChange(event.target.checked),
    }),
    el('span', { text: label }),
  ]);
}

// ------------------------------------------------------------ import / export

function renderTransfer(pane) {
  pane.append(
    el('div', { class: 'section' }, [
      el('h2', { text: 'Back up the vault' }),
      el('p', {
        text: 'The backup is the same encrypted file Keyring stores internally. It can only be opened with your master password.',
      }),
      el('div', { class: 'row', style: 'margin-top:10px' }, [
        el('button', { class: 'primary', text: 'Download encrypted backup', onclick: exportEncrypted }),
        el('button', { text: 'Export plain CSV', onclick: exportCsv }),
      ]),
    ]),
    authenticatorImportSection(),
    importSection(),
    restoreSection(),
  );
}

// Bringing codes over from a separate authenticator app or extension.
function authenticatorImportSection() {
  const paste = el('textarea', {
    class: 'mono',
    style: 'overflow-wrap:anywhere',
    placeholder:
      'otpauth://totp/GitHub:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub\notpauth://totp/...',
  });
  const status = el('p', { class: 'small muted' });
  const preview = el('div');
  let entries = [];

  const read = () => {
    preview.textContent = '';
    const result = parseAuthenticatorExport(paste.value);
    entries = result.entries;

    if (!entries.length && !result.problems.length) {
      status.textContent = 'Nothing to read yet.';
      return;
    }
    status.textContent = `${entries.length} code${entries.length === 1 ? '' : 's'} found` +
      (result.problems.length ? `, ${result.problems.length} line(s) could not be read.` : '.');

    for (const problem of result.problems.slice(0, 5)) {
      preview.append(el('p', { class: 'small', style: 'color:var(--danger)', text: problem }));
    }
    for (const entry of entries.slice(0, 20)) {
      preview.append(
        el('div', { class: 'small muted' }, [
          // A link with no issuer puts everything in the label, so fall back to it
          // rather than showing "Unnamed" next to a perfectly good name.
          el('span', {
            text:
              entry.issuer && entry.account
                ? `${entry.issuer} — ${entry.account}`
                : entry.issuer || entry.account || 'Unnamed',
          }),
        ]),
      );
    }
    if (entries.length > 20) {
      preview.append(el('p', { class: 'small muted', text: `…and ${entries.length - 20} more.` }));
    }
    if (entries.length) {
      preview.append(
        el('button', {
          class: 'primary',
          style: 'margin-top:10px',
          text: `Import ${entries.length} code${entries.length === 1 ? '' : 's'}`,
          onclick: runImport,
        }),
      );
    }
  };

  async function runImport() {
    // Same secret already saved anywhere means the same code; skip it.
    const existing = new Set(
      state.vault.items.filter((item) => item.totp).map((item) => item.totp.toUpperCase()),
    );

    let vault = state.vault;
    let added = 0;
    let skipped = 0;
    for (const entry of entries) {
      if (existing.has(entry.secret.toUpperCase())) {
        skipped += 1;
        continue;
      }
      existing.add(entry.secret.toUpperCase());
      vault = upsertItem(
        vault,
        newItem('totp', {
          name: entry.issuer || entry.account || 'Authenticator code',
          username: entry.account || '',
          totp: entry.secret,
          totpAlgorithm: entry.algorithm,
          totpDigits: entry.digits,
          totpPeriod: entry.period,
        }),
      );
      added += 1;
    }

    state.vault = vault;
    await persist();
    flashMessage(
      notice,
      `Imported ${added} code${added === 1 ? '' : 's'}` +
        (skipped ? `, skipped ${skipped} already saved.` : '.'),
      'ok',
      8000,
    );
    state.page = null;
    state.filter = { kind: 'type', value: 'totp' };
    render();
  }

  // A QR image, from a file or the clipboard, is turned into the otpauth link it
  // encodes and appended to the box above, so it goes through the same preview
  // and import path as a pasted link.
  async function readQrImage(source, label) {
    try {
      const text = await decodeQrFile(source);
      if (!/^otpauth:/i.test(text)) {
        throw new Error('That QR code holds something else, not an authenticator link.');
      }
      paste.value = (paste.value.trim() + '\n' + text).trim();
      read();
      flashMessage(notice, `Read a code from ${label}.`, 'ok');
    } catch (error) {
      flashMessage(notice, error.message, 'error', 8000);
    }
  }

  const imageInput = el('input', {
    type: 'file',
    accept: 'image/*',
    onchange: async (event) => {
      const file = event.target.files[0];
      if (file) await readQrImage(file, file.name);
      event.target.value = '';
    },
  });

  const section = el('div', { class: 'section' }, [
    el('h2', { text: 'Import authenticator codes' }),
    el('p', {
      text: 'Paste otpauth:// links, one per line, or the JSON an authenticator extension exports. Each one becomes an entry under Authenticator.',
    }),
    el('div', { class: 'field', style: 'margin-top:10px' }, [paste]),
    el('div', { class: 'row' }, [
      el('button', { text: 'Read pasted codes', onclick: read }),
      el('span', { class: 'grow' }),
    ]),
    el('p', {
      class: 'small muted',
      style: 'margin:14px 0 6px',
      text: 'Or read a QR code from a saved image, or paste one from the clipboard anywhere on this page. For a QR on a live page, use Scan QR on this page in the popup.',
    }),
    el('div', { class: 'field' }, [imageInput]),
    status,
    preview,
  ]);

  // Ctrl+V with a screenshot in the clipboard, anywhere on the page.
  const onPaste = (event) => {
    if (!section.isConnected) {
      document.removeEventListener('paste', onPaste);
      return;
    }
    const item = [...(event.clipboardData?.items || [])].find((entry) =>
      entry.type.startsWith('image/'),
    );
    if (!item) return;
    const file = item.getAsFile();
    if (file) {
      event.preventDefault();
      readQrImage(file, 'the clipboard');
    }
  };
  document.addEventListener('paste', onPaste);

  return section;
}

async function exportEncrypted() {
  try {
    const { blob } = await send(MSG.EXPORT);
    const stamp = new Date().toISOString().slice(0, 10);
    download(`keyring-backup-${stamp}.json`, JSON.stringify(blob, null, 2));
    flashMessage(notice, 'Encrypted backup downloaded. Keep it somewhere safe.', 'ok');
  } catch (error) {
    flashMessage(notice, error.message, 'error', 0);
  }
}

async function exportCsv() {
  const confirmed = await askConfirm({
    title: 'Export a plain CSV?',
    body: 'The file holds every password, card number and note in readable text. Anyone who opens it can read them, so delete it once you are done.',
    confirmLabel: 'Export',
    danger: true,
  });
  if (!confirmed) return;

  try {
    const stamp = new Date().toISOString().slice(0, 10);
    download(`keyring-plaintext-${stamp}.csv`, itemsToCsv(state.vault.items), 'text/csv');
    flashMessage(notice, 'Plain CSV downloaded. Delete it once you are done with it.', 'warn', 8000);
  } catch (error) {
    flashMessage(notice, error.message, 'error', 0);
  }
}

function importSection() {
  const status = el('p', { class: 'small muted' });
  const preview = el('div');
  let parsed = null;
  let source = '';
  let headerOverride = null; // null = decide from the file itself

  const handleText = (text) => {
    source = text;
    try {
      parsed = analyze(text, headerOverride === null ? {} : { hasHeader: headerOverride });
    } catch (error) {
      flashMessage(notice, error.message, 'error');
      return;
    }
    if (!parsed.dataRows.length) {
      status.textContent = 'That file has no rows.';
      preview.textContent = '';
      return;
    }
    const mapped = Object.values(parsed.mapping).filter((field) => field !== IGNORED).length;
    status.textContent = parsed.header
      ? `${parsed.dataRows.length} rows, ${mapped} of ${Object.keys(parsed.mapping).length} columns recognised. Check the mapping below.`
      : `${parsed.dataRows.length} rows, no header row found — choose what each column holds.`;
    drawMapping();
  };

  const fieldOptions = [
    [IGNORED, 'Ignore'],
    ...CSV_COLUMNS.map((field) => [field, field]),
  ];

  function drawMapping() {
    preview.textContent = '';
    const table = el('table', { class: 'map' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Column' }),
          el('th', { text: 'First row' }),
          el('th', { text: 'Import as' }),
        ]),
      ]),
    ]);
    const body = el('tbody');

    const sample = parsed.dataRows[0] || [];
    const columnCount = Math.max(...parsed.dataRows.map((row) => row.length));
    for (let index = 0; index < columnCount; index++) {
      body.append(
        el('tr', {}, [
          el('td', { text: parsed.header ? parsed.header[index] || `Column ${index + 1}` : `Column ${index + 1}` }),
          el('td', { class: 'sample', text: sample[index] || '' }),
          el('td', {}, [
            el(
              'select',
              {
                onchange: (event) => {
                  parsed.mapping[index] = event.target.value;
                },
              },
              fieldOptions.map(([value, label]) =>
                el('option', {
                  value,
                  text: label,
                  selected: (parsed.mapping[index] || '__ignore__') === value ? true : null,
                }),
              ),
            ),
          ]),
        ]),
      );
    }
    table.append(body);
    preview.append(
      el('label', { class: 'row', style: 'margin-bottom:10px' }, [
        el('input', {
          type: 'checkbox',
          style: 'width:auto',
          checked: parsed.header ? true : null,
          onchange: (event) => {
            headerOverride = event.target.checked;
            handleText(source);
          },
        }),
        el('span', { text: 'First row is a header' }),
      ]),
      table,
      el('button', { class: 'primary', text: 'Import these rows', onclick: runImport }),
    );
  }

  async function runImport() {
    const { items, skipped } = rowsToItems(parsed.dataRows, parsed.mapping);
    if (!items.length) {
      flashMessage(notice, 'Nothing to import — check the column mapping.', 'error');
      return;
    }
    const { fresh, duplicates } = dedupeAgainst(state.vault.items, items);

    let vault = state.vault;
    for (const item of fresh) vault = upsertItem(vault, item);
    state.vault = vault;
    await persist();

    const parts = [`Imported ${fresh.length} item${fresh.length === 1 ? '' : 's'}.`];
    if (duplicates.length) parts.push(`${duplicates.length} already in the vault, skipped.`);
    if (skipped.length) parts.push(`${skipped.length} row(s) needed attention.`);
    flashMessage(notice, parts.join(' '), 'ok', 9000);
    state.page = null;
    render();
  }

  const fileInput = el('input', {
    type: 'file',
    accept: '.csv,.txt,text/csv,text/plain',
    onchange: async (event) => {
      const file = event.target.files[0];
      if (file) handleText(await readFile(file));
    },
  });

  const paste = el('textarea', { placeholder: '…or paste CSV rows here' });

  return el('div', { class: 'section' }, [
    el('h2', { text: 'Import a CSV' }),
    el('p', {
      text: `Keyring's own columns are ${CSV_COLUMNS.join(', ')} — a file with those headings imports as-is. Any other CSV works too: whatever the headings are, you map each column to a field below.`,
    }),
    el('div', { class: 'row', style: 'margin:10px 0' }, [
      el('button', {
        text: 'Download a blank template',
        onclick: () => {
          download('keyring-template.csv', templateCsv(), 'text/csv');
          flashMessage(notice, 'Template downloaded — fill it in and import it back.', 'ok');
        },
      }),
    ]),
    el('div', { class: 'field' }, [fileInput]),
    el('div', { class: 'field' }, [
      paste,
      el('button', {
        text: 'Read pasted rows',
        onclick: () => handleText(paste.value),
      }),
    ]),
    status,
    preview,
  ]);
}

function restoreSection() {
  const fileInput = el('input', { type: 'file', accept: '.json,application/json' });
  const passwordInput = el('input', {
    type: 'password',
    placeholder: 'Master password of that backup',
    autocomplete: 'off',
  });

  return el('div', { class: 'section' }, [
    el('h2', { text: 'Restore an encrypted backup' }),
    el('p', {
      text: 'This replaces everything currently in the vault with the contents of the backup file.',
    }),
    el('div', { class: 'field' }, [fileInput]),
    el('div', { class: 'field' }, [passwordInput]),
    el('button', {
      class: 'danger',
      text: 'Replace vault with this backup',
      onclick: async () => {
        const file = fileInput.files[0];
        if (!file) return flashMessage(notice, 'Choose a backup file first.', 'error');
        const confirmed = await askConfirm({
          title: 'Replace the vault?',
          body: 'Everything currently in the vault is discarded and replaced by the contents of the backup file.',
          confirmLabel: 'Replace',
          danger: true,
        });
        if (!confirmed) return;
        try {
          const blob = JSON.parse(await readFile(file));
          const result = await send(MSG.IMPORT_BLOB, { blob, password: passwordInput.value });
          passwordInput.value = '';
          flashMessage(notice, `Restored ${result.itemCount} items.`, 'ok');
          state.page = null;
          await load();
        } catch (error) {
          flashMessage(notice, error.message, 'error', 0);
        }
      },
    }),
  ]);
}

// -------------------------------------------------------------------- security

function renderSecurity(pane) {
  const current = el('input', { type: 'password', autocomplete: 'off' });
  const next = el('input', { type: 'password', autocomplete: 'new-password' });
  const confirmInput = el('input', { type: 'password', autocomplete: 'new-password' });

  pane.append(
    el('div', { class: 'section' }, [
      el('h2', { text: 'Change the master password' }),
      el('p', { text: 'The vault is re-encrypted with the new password. Older backups still need the old one.' }),
      el('div', { class: 'field' }, [el('label', { text: 'Current master password' }), current]),
      el('div', { class: 'field' }, [el('label', { text: 'New master password' }), next]),
      el('div', { class: 'field' }, [el('label', { text: 'Confirm new password' }), confirmInput]),
      el('button', {
        class: 'primary',
        text: 'Change password',
        onclick: async () => {
          if (next.value.length < 10) {
            return flashMessage(notice, 'Use at least 10 characters.', 'error');
          }
          if (next.value !== confirmInput.value) {
            return flashMessage(notice, 'The two new passwords do not match.', 'error');
          }
          try {
            await send(MSG.CHANGE_PASSWORD, {
              currentPassword: current.value,
              nextPassword: next.value,
            });
            current.value = next.value = confirmInput.value = '';
            flashMessage(notice, 'Master password changed. Download a fresh backup.', 'ok', 9000);
          } catch (error) {
            flashMessage(notice, error.message, 'error', 0);
          }
        },
      }),
    ]),

    el('div', { class: 'section' }, [
      el('h2', { text: 'How the vault is protected' }),
      el('ul', { class: 'small muted' }, [
        el('li', { text: 'PBKDF2-SHA256, 600,000 iterations, then AES-256-GCM over the whole vault.' }),
        el('li', { text: 'The master password is never stored, and the key lives in memory only while unlocked.' }),
        el('li', { text: 'Nothing is sent anywhere: the extension makes no network requests at all.' }),
        el('li', { text: 'A site only ever receives the one credential you pick for it.' }),
      ]),
    ]),

    el('div', { class: 'section' }, [
      el('div', { class: 'danger-zone' }, [
        el('h2', { text: 'Delete everything' }),
        el('p', { class: 'small', text: 'Erases the vault from this browser profile. There is no undo and no recovery.' }),
        el('button', {
          class: 'danger',
          text: 'Delete this vault',
          onclick: async () => {
            const confirmed = await askConfirm({
              title: 'Delete this vault?',
              body: 'Every item is erased from this browser profile. Nothing can bring it back except a backup file you already downloaded.',
              confirmLabel: 'Delete everything',
              danger: true,
              phrase: 'DELETE',
            });
            if (!confirmed) return;
            await send(MSG.WIPE);
            location.replace('../onboarding/onboarding.html');
          },
        }),
      ]),
    ]),
  );
}

// --------------------------------------------------------------------- wiring

// ------------------------------------------------------------------ splitter

const LIST_WIDTH_KEY = 'keyring.listWidth';
const MIN_LIST_WIDTH = 220;

function applyListWidth(pixels) {
  const panes = qs('.panes');
  const available = panes.getBoundingClientRect().width;
  // Always leave a usable editor beside it.
  const maximum = Math.max(MIN_LIST_WIDTH, available - 380);
  const clamped = Math.round(Math.min(Math.max(pixels, MIN_LIST_WIDTH), maximum));
  panes.style.setProperty('--list-width', `${clamped}px`);
  return clamped;
}

function wireSplitter() {
  const splitter = qs('#splitter');
  const panes = qs('.panes');

  // A window-level UI preference, not vault data, so it lives in localStorage.
  // Set without clamping: this runs while the app is still hidden, so the
  // container measures zero and every width would clamp to the minimum. It is
  // re-clamped once the app is on screen.
  const saved = Number(localStorage.getItem(LIST_WIDTH_KEY));
  if (saved > 0) panes.style.setProperty('--list-width', `${Math.round(saved)}px`);

  const onMove = (event) => {
    applyListWidth(event.clientX - panes.getBoundingClientRect().left);
  };

  const stop = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', stop);
    splitter.dataset.dragging = '0';
    delete document.body.dataset.resizing;
    const width = parseInt(panes.style.getPropertyValue('--list-width'), 10);
    if (width > 0) localStorage.setItem(LIST_WIDTH_KEY, String(width));
  };

  splitter.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    splitter.dataset.dragging = '1';
    document.body.dataset.resizing = '1';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
  });

  // Keyboard: the handle is focusable, so it should move without a mouse.
  splitter.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 40 : 12;
    const current =
      parseInt(panes.style.getPropertyValue('--list-width'), 10) ||
      qs('#list-pane').getBoundingClientRect().width;
    if (event.key === 'ArrowLeft') {
      localStorage.setItem(LIST_WIDTH_KEY, String(applyListWidth(current - step)));
    } else if (event.key === 'ArrowRight') {
      localStorage.setItem(LIST_WIDTH_KEY, String(applyListWidth(current + step)));
    } else {
      return;
    }
    event.preventDefault();
  });

  // Keep it inside the window when the window itself changes size.
  window.addEventListener('resize', () => {
    const current = parseInt(panes.style.getPropertyValue('--list-width'), 10);
    if (current > 0) applyListWidth(current);
  });
}

function wireStatic() {
  wireSplitter();
  qs('#gate-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await send(MSG.UNLOCK, { password: qs('#gate-password').value });
      qs('#gate-password').value = '';
      qs('#gate-error').classList.add('hidden');
      await load();
    } catch (error) {
      flashMessage(qs('#gate-error'), error.message, 'error', 0);
    }
  });

  qs('#search').addEventListener('input', (event) => {
    state.query = event.target.value;
    state.page = null;
    render();
  });

  qs('#new-login').addEventListener('click', () => startNew('login'));
  qs('#new-note').addEventListener('click', () => startNew('note'));
  qs('#new-card').addEventListener('click', () => startNew('card'));
  qs('#new-code').addEventListener('click', () => startNew('totp'));

  qs('#lock').addEventListener('click', async () => {
    await send(MSG.LOCK);
    location.reload();
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'state:locked') location.reload();
});

boot().catch((error) => {
  document.body.textContent = '';
  document.body.append(
    el('div', { class: 'gate' }, [
      el('div', { class: 'card gate-card' }, [
        el('h2', { text: 'Keyring could not start' }),
        el('p', { class: 'muted small', text: error.message }),
      ]),
    ]),
  );
});
