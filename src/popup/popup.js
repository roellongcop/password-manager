import {
  MSG,
  send,
  el,
  qs,
  qsa,
  copyWithAutoClear,
  applyTheme,
  relativeDate,
  domainIconLetter,
  tintFor,
  flashMessage,
  typeChip,
} from '../ui/common.js';
import {
  searchItems,
  sortItems,
  publicSummary,
  hasTotp,
  totpConfig,
  newItem,
  upsertItem,
} from '../lib/vault.js';
import { rankMatches, registrableDomain } from '../lib/matcher.js';
import { generateTotp, secondsRemaining, parseTotpInput } from '../lib/totp.js';
import {
  generatePassword,
  generatePassphrase,
  passwordEntropyBits,
  passphraseEntropyBits,
} from '../lib/generator.js';

const state = {
  vault: null,
  tab: null,
  query: '',
  view: 'vault', // vault | detail | codes | generator
  selectedId: '',
  pending: null,
  totpTimer: 0,
};

const generatorState = {
  mode: 'password',
  password: { length: 20, lower: true, upper: true, digits: true, symbols: true, excludeAmbiguous: false },
  passphrase: { words: 5, separator: '-', capitalize: true, includeNumber: true },
  value: '',
};

// ------------------------------------------------------------------ bootstrap

async function boot() {
  wireStaticHandlers();
  state.tab = await currentTab();

  const status = await send(MSG.STATUS);
  if (!status.initialized) return show('setup');
  if (status.locked) {
    show('locked');
    qs('#master').focus();
    return;
  }
  state.pending = status.pendingCapture;
  await loadVault();
}

async function currentTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && /^https?:/.test(active.url || '')) return active;
  // The standalone popup window is itself the active tab; look past it.
  const tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
  return tabs.find((tab) => /^https?:/.test(tab.url || '')) || active || null;
}

function show(name) {
  for (const view of qsa('.view')) view.classList.add('hidden');
  qs(`#view-${name}`).classList.remove('hidden');
}

async function loadVault() {
  const { vault } = await send(MSG.GET);
  state.vault = vault;
  applyTheme(vault.settings.theme);
  show('main');
  setView(state.view);
}

// ---------------------------------------------------------------------- views

function setView(view) {
  state.view = view;
  qs('#list').classList.toggle('hidden', view !== 'vault');
  qs('#detail').classList.toggle('hidden', view !== 'detail');
  qs('#codes').classList.toggle('hidden', view !== 'codes');
  qs('#generator').classList.toggle('hidden', view !== 'generator');

  // The detail view belongs to the Vault tab, so that tab stays lit while an item
  // is open.
  const activeTab = view === 'detail' ? 'vault' : view;
  for (const tab of qsa('.tab')) {
    tab.dataset.active = tab.dataset.tab === activeTab ? '1' : '0';
  }

  stopTotpTimer();
  if (view === 'vault') renderList();
  if (view === 'codes') renderCodes();
  if (view === 'generator') renderGenerator();
  renderPending();
}

// ------------------------------------------------------------------- the list

function renderList() {
  const container = qs('#list');
  container.textContent = '';

  const all = state.vault.items;
  const filtered = sortItems(searchItems(all, state.query));

  const pageUrl = state.tab?.url || '';
  const forSite = state.query ? [] : rankMatches(all, pageUrl);
  const forSiteIds = new Set(forSite.map((item) => item.id));

  if (forSite.length) {
    container.append(groupTitle(`For ${registrableDomain(pageUrl)}`));
    for (const item of forSite) container.append(entryRow(item, true));
  }

  const rest = filtered.filter((item) => !forSiteIds.has(item.id));
  if (rest.length) {
    container.append(groupTitle(state.query ? 'Results' : 'All items'));
    for (const item of rest) container.append(entryRow(item, false));
  }

  if (!forSite.length && !rest.length) {
    container.append(
      el('div', { class: 'empty' }, [
        el('p', { text: all.length ? 'Nothing matches that search.' : 'Your vault is empty.' }),
        all.length
          ? null
          : el('button', { class: 'primary', onclick: openOptions, text: 'Add or import logins' }),
      ]),
    );
  }
}

function groupTitle(text) {
  return el('div', { class: 'group-title', text });
}

function entryRow(item, matchesSite) {
  const summary = publicSummary(item);
  return el(
    'button',
    { class: 'entry', onclick: () => openDetail(item.id) },
    [
      el('span', {
        class: 'avatar',
        text: domainIconLetter(item),
        style: `background:${tintFor(summary.name)}`,
      }),
      el('span', { class: 'lines' }, [
        el('span', { class: 'name', text: summary.name }),
        el('span', {
          class: 'sub',
          text: summary.username || labelForType(item),
        }),
      ]),
      typeChip(item),
      matchesSite ? el('span', { class: 'badge', text: 'FILL' }) : null,
    ],
  );
}

function labelForType(item) {
  if (item.type === 'note') return item.folder || 'Secure note';
  if (item.type === 'totp') return 'Authenticator code';
  if (item.type === 'card') return item.number ? maskCard(item.number) : 'Payment card';
  return 'No username';
}

function maskCard(number) {
  const digits = String(number).replace(/\D/g, '');
  return digits.length > 4 ? `•••• ${digits.slice(-4)}` : digits;
}

// ------------------------------------------------------------------- detail

function openDetail(id) {
  state.selectedId = id;
  setView('detail');
  renderDetail();
}

function renderDetail() {
  const item = state.vault.items.find((entry) => entry.id === state.selectedId);
  const container = qs('#detail');
  container.textContent = '';
  if (!item) return setView('vault');

  container.append(
    el('div', { class: 'row', style: 'margin-bottom:10px' }, [
      el('button', { class: 'icon', text: '← Back', onclick: () => setView('vault') }),
      el('span', { class: 'grow' }),
      el('button', { class: 'icon', text: 'Edit', onclick: () => openOptions(item.id) }),
    ]),
    el('div', { class: 'detail-head' }, [
      el('span', {
        class: 'avatar',
        text: domainIconLetter(item),
        style: `background:${tintFor(item.name || item.username || '?')}`,
      }),
      el('span', { class: 'lines' }, [
        el('span', { class: 'name', text: item.name || 'Untitled' }),
        el('span', {
          class: 'sub muted small',
          text: `Last used ${relativeDate(item.lastUsedAt)}`,
        }),
      ]),
    ]),
  );

  if (item.type === 'login') {
    const canFill = state.tab && rankMatches([item], state.tab.url || '').length > 0;
    container.append(
      el('button', {
        class: 'primary wide',
        text: canFill ? 'Fill on this page' : 'Not saved for this page',
        disabled: !canFill,
        style: 'margin-bottom:12px',
        onclick: () => fillIntoPage(item.id),
      }),
    );

    if (item.username) container.append(fieldBlock('Username', item.username, false));
    if (item.password) {
      container.append(fieldBlock('Password', item.password, true, { itemId: item.id }));
    }
    if (item.totp) container.append(totpBlock(item));
    for (const uri of item.uris || []) {
      container.append(fieldBlock('Website', uri.uri, false, { link: true }));
    }
  }

  if (item.type === 'totp') {
    const canFill = state.tab && rankMatches([item], state.tab.url || '').length > 0;
    container.append(
      el('button', {
        class: 'primary wide',
        text: canFill ? 'Fill the code on this page' : 'Not linked to this page',
        disabled: !canFill,
        style: 'margin-bottom:12px',
        onclick: () => fillIntoPage(item.id),
      }),
    );
    if (item.username) container.append(fieldBlock('Account', item.username, false));
    container.append(totpBlock(item));
    for (const uri of item.uris || []) {
      container.append(fieldBlock('Website', uri.uri, false, { link: true }));
    }
  }

  if (item.type === 'card') {
    if (item.cardholder) container.append(fieldBlock('Cardholder', item.cardholder, false));
    if (item.number) {
      container.append(fieldBlock('Card number', item.number, true, { itemId: item.id }));
    }
    if (item.expMonth || item.expYear) {
      container.append(fieldBlock('Expires', `${item.expMonth}/${item.expYear}`, false));
    }
    if (item.cvv) container.append(fieldBlock('Security code', item.cvv, true));
  }

  for (const field of item.customFields || []) {
    container.append(fieldBlock(field.name, field.value, Boolean(field.hidden)));
  }

  if (item.notes) container.append(notesBlock(item.notes));
}

function fieldBlock(label, value, secret, options = {}) {
  const usedId = options.itemId || '';
  const display = el('span', {
    class: `value${secret ? ' hidden-value mono' : ''}`,
    text: secret ? '•'.repeat(Math.min(20, value.length)) : value,
  });

  const wrapper = el('div', { class: 'field' }, [
    el('label', { text: label }),
    el('div', { class: 'secret' }, [
      display,
      secret
        ? el('button', {
            class: 'icon',
            text: 'Show',
            onclick: (event) => {
              const revealed = display.classList.toggle('hidden-value');
              display.textContent = revealed ? '•'.repeat(Math.min(20, value.length)) : value;
              event.currentTarget.textContent = revealed ? 'Show' : 'Hide';
            },
          })
        : null,
      el('button', {
        class: 'icon',
        text: 'Copy',
        onclick: (event) => copyValue(value, event.currentTarget, usedId),
      }),
      options.link
        ? el('button', {
            class: 'icon',
            text: 'Open',
            onclick: () => chrome.tabs.create({ url: value }),
          })
        : null,
    ]),
  ]);
  return wrapper;
}

function notesBlock(notes) {
  return el('div', { class: 'field' }, [
    el('div', { class: 'row' }, [
      el('label', { text: 'Notes', style: 'margin:0' }),
      el('span', { class: 'grow' }),
      el('button', {
        class: 'icon',
        text: 'Copy',
        onclick: (event) => copyValue(notes, event.currentTarget),
      }),
    ]),
    // pre-wrap keeps the line breaks; anywhere breaks a long unbroken token such
    // as a key or a base64 blob, which would otherwise run off the side.
    el('div', {
      class: 'card small mono',
      style: 'white-space:pre-wrap; overflow-wrap:anywhere; margin-top:5px',
      text: notes,
    }),
  ]);
}

function totpBlock(item) {
  const code = el('span', { class: 'code mono', text: '------' });
  const ring = el('span', { class: 'ring-wrap' });
  ring.innerHTML =
    '<svg class="ring" viewBox="0 0 26 26"><circle class="track" cx="13" cy="13" r="11"/>' +
    '<circle class="value" cx="13" cy="13" r="11" stroke-dasharray="69.1" stroke-dashoffset="0"/></svg>';

  const block = el('div', { class: 'field' }, [
    el('label', { text: 'Authenticator code' }),
    el('div', { class: 'secret totp' }, [
      ring,
      code,
      el('span', { class: 'grow' }),
      el('button', {
        class: 'icon',
        text: 'Copy',
        onclick: (event) => copyValue(code.textContent, event.currentTarget, item.id),
      }),
    ]),
  ]);

  const tick = async () => {
    try {
      const config = totpConfig(item);
      code.textContent = await generateTotp(config);
      const left = secondsRemaining(config.period);
      const circle = ring.querySelector('.value');
      circle.style.strokeDashoffset = String((69.1 * (config.period - left)) / config.period);
    } catch {
      code.textContent = 'invalid';
    }
  };
  tick();
  state.totpTimer = setInterval(tick, 1000);
  return block;
}

function stopTotpTimer() {
  if (state.totpTimer) clearInterval(state.totpTimer);
  state.totpTimer = 0;
}

async function copyValue(value, button, itemId = '') {
  try {
    await copyWithAutoClear(value, state.vault.settings.clipboardClearSeconds);
    if (itemId) send(MSG.USED, { itemId }).catch(() => {});
    // Swapping textContent is only safe on a button whose whole content is that
    // one label. On a button built from child elements it would delete them all,
    // so those get a data attribute and let CSS do the talking.
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
    flashMessage(qs('#notice'), 'Could not reach the clipboard.', 'error');
  }
}

async function fillIntoPage(itemId) {
  try {
    await send(MSG.FILL_FROM_POPUP, { itemId, tabId: state.tab?.id });
    window.close();
  } catch (error) {
    flashMessage(qs('#notice'), error.message, 'error');
  }
}

// --------------------------------------------------------------- authenticator

// Ask the service worker to run a scan. It puts a selection overlay on the page,
// and the moment the user clicks into that overlay this popup is dismissed -- so
// the worker finishes the job on its own and reports back on the page itself.
async function scanForCode() {
  try {
    // This does not resolve until the selection is done, by which point the popup
    // has already been dismissed by the click into the page. Awaiting it anyway is
    // what surfaces the early failures -- no usable tab, no content script.
    await send(MSG.SCAN_TAB, { tabId: state.tab?.id });
  } catch (error) {
    flashMessage(qs('#notice'), error.message, 'error', 8000);
  }
}

// Every code in the vault on one screen: standalone entries and the codes attached
// to logins, ticking together off a single timer.
function renderCodes() {
  const container = qs('#codes');
  container.textContent = '';

  container.append(
    el('div', { class: 'row', style: 'margin-bottom:10px' }, [
      el('button', {
        class: 'primary grow',
        text: 'Scan QR on this page',
        onclick: scanForCode,
      }),
      el('button', { text: 'Add', title: 'Add a code by hand', onclick: () => openOptions('newcode') }),
    ]),
  );

  const withCodes = searchItems(
    state.vault.items.filter((item) => hasTotp(item)),
    state.query,
  );

  if (!withCodes.length) {
    container.append(
      el('div', { class: 'empty' }, [
        el('p', {
          text: state.query
            ? 'No codes match that search.'
            : 'No authenticator codes yet.',
        }),
        state.query
          ? null
          : el('button', {
              class: 'primary',
              text: 'Add or import codes by hand',
              onclick: () => openOptions('newcode'),
            }),
      ]),
    );
    return;
  }

  // Codes for the site you are on come first.
  const pageUrl = state.tab?.url || '';
  const forSite = new Set(rankMatches(withCodes, pageUrl).map((item) => item.id));
  const ordered = [
    ...sortItems(withCodes.filter((item) => forSite.has(item.id))),
    ...sortItems(withCodes.filter((item) => !forSite.has(item.id))),
  ];

  const rows = [];
  for (const item of ordered) {
    const config = totpConfig(item);
    const code = el('span', { class: 'code mono', text: '······' });
    const ring = el('span', { class: 'ring-wrap' });
    ring.innerHTML =
      '<svg class="ring" viewBox="0 0 26 26"><circle class="track" cx="13" cy="13" r="11"/>' +
      '<circle class="value" cx="13" cy="13" r="11" stroke-dasharray="69.1" stroke-dashoffset="0"/></svg>';

    // The click copies the digits the timer last computed, not whatever happens
    // to be in the DOM at that instant.
    const rowState = { item, config, code, ring, value: '' };

    const row = el(
      'button',
      {
        class: 'entry code-row',
        title: 'Click to copy this code',
        onclick: (event) => {
          if (!rowState.value) return;
          copyValue(rowState.value, event.currentTarget, item.id);
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
          el('span', { class: 'sub', text: item.username || labelForType(item) }),
        ]),
        code,
        ring,
        el('span', { class: 'copied', text: 'Copied' }),
      ],
    );

    if (forSite.has(item.id)) row.dataset.forSite = '1';
    rows.push(rowState);
    container.append(row);
  }

  // One timer for the whole list rather than one per row.
  const tick = async () => {
    for (const row of rows) {
      try {
        const value = await generateTotp(row.config);
        // Grouped in threes, the way authenticator apps show it. Only touch the
        // DOM when the digits actually change, so the text is not replaced under
        // the pointer every second.
        const shown = value.length === 6 ? `${value.slice(0, 3)} ${value.slice(3)}` : value;
        if (row.code.textContent !== shown) row.code.textContent = shown;
        row.value = value;
        const left = secondsRemaining(row.config.period);
        const circle = row.ring.querySelector('.value');
        if (circle) {
          circle.style.strokeDashoffset = String(
            (69.1 * (row.config.period - left)) / row.config.period,
          );
          circle.style.stroke = left <= 5 ? 'var(--danger)' : 'var(--accent)';
        }
      } catch {
        row.code.textContent = 'invalid';
      }
    }
  };
  tick();
  state.totpTimer = setInterval(tick, 1000);
}

// ----------------------------------------------------------------- generator

function renderGenerator() {
  const container = qs('#generator');
  container.textContent = '';

  const output = el('div', { class: 'gen-output mono' });
  const meter = el('div', { class: 'meter' }, [el('span')]);
  const strengthText = el('p', { class: 'small muted', style: 'margin:6px 0 14px' });

  const regenerate = () => {
    generatorState.value =
      generatorState.mode === 'passphrase'
        ? generatePassphrase(generatorState.passphrase)
        : generatePassword(generatorState.password);
    output.textContent = generatorState.value;

    const bits =
      generatorState.mode === 'passphrase'
        ? passphraseEntropyBits(generatorState.passphrase)
        : passwordEntropyBits(generatorState.password);
    const score = bits < 45 ? 1 : bits < 70 ? 2 : bits < 100 ? 3 : 4;
    meter.dataset.score = String(score);
    meter.firstChild.style.width = `${Math.min(100, (bits / 128) * 100)}%`;
    strengthText.textContent = `${bits} bits of entropy`;
  };

  const segment = el('div', { class: 'seg' }, [
    el('button', {
      text: 'Password',
      dataset: { active: generatorState.mode === 'password' ? '1' : '0' },
      onclick: () => {
        generatorState.mode = 'password';
        renderGenerator();
      },
    }),
    el('button', {
      text: 'Passphrase',
      dataset: { active: generatorState.mode === 'passphrase' ? '1' : '0' },
      onclick: () => {
        generatorState.mode = 'passphrase';
        renderGenerator();
      },
    }),
  ]);

  container.append(segment, output, meter, strengthText);

  if (generatorState.mode === 'password') {
    const config = generatorState.password;
    const lengthLabel = el('span', { class: 'small muted', text: String(config.length) });
    container.append(
      el('div', { class: 'field' }, [
        el('label', { text: 'Length' }),
        el('div', { class: 'slider' }, [
          el('input', {
            type: 'range',
            min: '8',
            max: '64',
            value: String(config.length),
            oninput: (event) => {
              config.length = Number(event.target.value);
              lengthLabel.textContent = event.target.value;
              regenerate();
            },
          }),
          lengthLabel,
        ]),
      ]),
      el('div', { class: 'toggles' }, [
        checkbox('a-z', config, 'lower', regenerate),
        checkbox('A-Z', config, 'upper', regenerate),
        checkbox('0-9', config, 'digits', regenerate),
        checkbox('!@#$', config, 'symbols', regenerate),
        checkbox('Avoid look-alikes', config, 'excludeAmbiguous', regenerate),
      ]),
    );
  } else {
    const config = generatorState.passphrase;
    const wordLabel = el('span', { class: 'small muted', text: String(config.words) });
    container.append(
      el('div', { class: 'field' }, [
        el('label', { text: 'Words' }),
        el('div', { class: 'slider' }, [
          el('input', {
            type: 'range',
            min: '3',
            max: '10',
            value: String(config.words),
            oninput: (event) => {
              config.words = Number(event.target.value);
              wordLabel.textContent = event.target.value;
              regenerate();
            },
          }),
          wordLabel,
        ]),
      ]),
      el('div', { class: 'toggles' }, [
        checkbox('Capitalise', config, 'capitalize', regenerate),
        checkbox('Add a number', config, 'includeNumber', regenerate),
      ]),
    );
  }

  container.append(
    el('div', { class: 'row' }, [
      el('button', {
        class: 'primary grow',
        text: 'Copy',
        onclick: (event) => copyValue(generatorState.value, event.currentTarget),
      }),
      el('button', { class: 'grow', text: 'Regenerate', onclick: regenerate }),
    ]),
  );

  regenerate();
}

function checkbox(label, config, key, onChange) {
  return el('label', { class: 'toggle' }, [
    el('input', {
      type: 'checkbox',
      checked: config[key] ? true : null,
      onchange: (event) => {
        config[key] = event.target.checked;
        onChange();
      },
    }),
    el('span', { text: label }),
  ]);
}

// ------------------------------------------------------------ pending capture

function renderPending() {
  const container = qs('#pending');
  container.textContent = '';
  if (!state.pending || state.view !== 'vault') {
    container.classList.add('hidden');
    return;
  }

  const domain = registrableDomain(state.pending.url) || 'this site';
  const existing = rankMatches(state.vault.items, state.pending.url).find(
    (item) => (item.username || '').toLowerCase() === (state.pending.username || '').toLowerCase(),
  );

  container.classList.remove('hidden');
  container.append(
    el('div', { class: 'small' }, [
      el('strong', { text: existing ? 'Update this password?' : 'Save this login?' }),
      el('div', {
        class: 'muted',
        text: `${state.pending.username || 'No username'} on ${domain}`,
      }),
    ]),
    el('div', { class: 'row' }, [
      el('button', {
        class: 'primary',
        text: existing ? 'Update' : 'Save',
        onclick: async () => {
          await send(MSG.CAPTURE_SAVE, {
            action: existing ? 'update' : 'new',
            itemId: existing ? existing.id : '',
          });
          state.pending = null;
          await loadVault();
        },
      }),
      el('button', {
        text: 'Dismiss',
        onclick: async () => {
          await send(MSG.CAPTURE_DISCARD);
          state.pending = null;
          renderPending();
        },
      }),
    ]),
  );
}

// -------------------------------------------------------------------- wiring

function openOptions(itemId = '') {
  const url = chrome.runtime.getURL(
    'src/options/options.html' + (itemId ? `#item=${encodeURIComponent(itemId)}` : ''),
  );
  chrome.tabs.create({ url });
  window.close();
}

function wireStaticHandlers() {
  qs('#setup-start').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/onboarding/onboarding.html') });
    window.close();
  });

  qs('#unlock-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = qs('#master');
    const button = qs('#unlock');
    button.disabled = true;
    button.textContent = 'Unlocking…';
    try {
      await send(MSG.UNLOCK, { password: input.value });
      input.value = '';
      qs('#unlock-error').classList.add('hidden');
      const status = await send(MSG.STATUS);
      state.pending = status.pendingCapture;
      await loadVault();
    } catch (error) {
      flashMessage(qs('#unlock-error'), error.message, 'error', 0);
      input.select();
    } finally {
      button.disabled = false;
      button.textContent = 'Unlock';
    }
  });

  qs('#search').addEventListener('input', (event) => {
    state.query = event.target.value;
    if (state.view === 'codes') renderCodes();
    else if (state.view !== 'vault') setView('vault');
    else renderList();
  });

  qs('#lock').addEventListener('click', async () => {
    await send(MSG.LOCK);
    window.close();
  });

  qs('#add').addEventListener('click', () => openOptions('new'));
  qs('#tab-vault').addEventListener('click', () => setView('vault'));
  qs('#tab-codes').addEventListener('click', () => setView('codes'));
  qs('#tab-generator').addEventListener('click', () => setView('generator'));
  qs('#tab-settings').addEventListener('click', () => openOptions());

  window.addEventListener('unload', stopTotpTimer);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'state:locked') window.close();
  if (message?.type === 'state:changed' && state.vault) loadVault();
});

boot().catch((error) => {
  document.body.textContent = '';
  document.body.append(
    el('div', { class: 'hero' }, [
      el('h2', { text: 'Keyring could not start' }),
      el('p', { class: 'muted small', text: error.message }),
    ]),
  );
});
