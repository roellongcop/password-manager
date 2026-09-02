// The in-field icon and the dropdown it opens.
//
// Both live in a CLOSED shadow root: page CSS cannot restyle them, page scripts
// cannot read them through host.shadowRoot, and item names are written with
// textContent so a crafted vault entry can never inject markup.

(() => {
  const ICON_SIZE = 20;

  let host = null;
  let root = null;
  let iconButton = null;
  let panel = null;
  let anchorField = null;
  let anchorGroup = null;
  let open = false;
  let cache = { at: 0, url: '', data: null };

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
    .icon {
      position: fixed; width: ${ICON_SIZE}px; height: ${ICON_SIZE}px;
      padding: 0; margin: 0; border: 0; border-radius: 5px;
      background: #2f6f4f; color: #fff; cursor: pointer;
      display: none; align-items: center; justify-content: center;
      z-index: 2147483647; box-shadow: 0 1px 3px rgba(0,0,0,.3);
    }
    .icon[data-locked="1"] { background: #6b7280; }
    .icon svg { width: 12px; height: 12px; display: block; }
    .panel {
      position: fixed; z-index: 2147483647; display: none;
      min-width: 240px; max-width: 360px; max-height: 320px; overflow-y: auto;
      background: #ffffff; color: #101418;
      border: 1px solid #d8dee6; border-radius: 10px;
      box-shadow: 0 10px 30px rgba(15,23,42,.18);
      padding: 6px; font-size: 13px; line-height: 1.35;
    }
    .row {
      display: flex; flex-direction: column; gap: 1px;
      width: 100%; text-align: left; padding: 7px 9px;
      border: 0; border-radius: 7px; background: transparent; cursor: pointer;
      font-size: 13px; color: inherit;
    }
    .row:hover, .row:focus-visible { background: #eef4f0; outline: none; }
    .row .name { font-weight: 600; }
    .row .sub { color: #5b6572; font-size: 12px; }
    .head {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 9px 7px; color: #5b6572; font-size: 11px;
      text-transform: uppercase; letter-spacing: .04em;
    }
    .sep { height: 1px; background: #e6ebf1; margin: 5px 2px; }
    .empty { padding: 8px 9px; color: #5b6572; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #171b21; color: #e8edf3; border-color: #2b323c; }
      .row:hover, .row:focus-visible { background: #232a33; }
      .row .sub, .head, .empty { color: #98a2b3; }
      .sep { background: #2b323c; }
    }
  `;

  const KEY_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3"/><path d="M17 6l2.5 2.5"/></svg>';

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;';
    root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = STYLES;

    iconButton = document.createElement('button');
    iconButton.className = 'icon';
    iconButton.type = 'button';
    iconButton.title = 'Keyring';
    iconButton.innerHTML = KEY_SVG;
    iconButton.addEventListener('mousedown', (event) => event.preventDefault());
    iconButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });

    panel = document.createElement('div');
    panel.className = 'panel';
    panel.addEventListener('mousedown', (event) => event.preventDefault());

    root.append(style, iconButton, panel);
    (document.documentElement || document.body).appendChild(host);
  }

  async function matches(force = false) {
    const url = location.href;
    if (!force && cache.data && cache.url === url && Date.now() - cache.at < 15000) {
      return cache.data;
    }
    const data = await KEYRING.send(KEYRING.MSG.MATCHES, { url });
    cache = { at: Date.now(), url, data: data || { locked: true, items: [] } };
    return cache.data;
  }

  KEYRING.invalidateMatches = () => {
    cache = { at: 0, url: '', data: null };
  };

  async function showIconFor(field, group) {
    ensureHost();
    anchorField = field;
    anchorGroup = group;

    const data = await matches();
    if (!data || data.never) return hideIcon();
    if (!data.locked && data.showIcon === false) return hideIcon();

    const isPasswordField = field.type === 'password';
    const worthShowing = data.locked || data.items.length > 0 || isPasswordField;
    if (!worthShowing) return hideIcon();

    iconButton.dataset.locked = data.locked ? '1' : '0';
    iconButton.style.display = 'flex';
    positionIcon();
  }

  function hideIcon() {
    if (!iconButton) return;
    iconButton.style.display = 'none';
    closeMenu();
  }

  function positionIcon() {
    if (!anchorField || !anchorField.isConnected || iconButton.style.display === 'none') return;
    const rect = anchorField.getBoundingClientRect();
    const offscreen =
      rect.bottom < 0 || rect.top > window.innerHeight || rect.width === 0 || rect.height === 0;
    if (offscreen) return hideIcon();

    iconButton.style.left = `${Math.round(rect.right - ICON_SIZE - 6)}px`;
    iconButton.style.top = `${Math.round(rect.top + (rect.height - ICON_SIZE) / 2)}px`;
    if (open) positionPanel(rect);
  }

  function positionPanel(rect = anchorField?.getBoundingClientRect()) {
    if (!rect) return;
    const width = Math.max(240, Math.min(360, rect.width));
    panel.style.width = `${Math.round(width)}px`;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    panel.style.left = `${Math.round(left)}px`;

    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 180 && rect.top > 200) {
      panel.style.top = '';
      panel.style.bottom = `${Math.round(window.innerHeight - rect.top + 6)}px`;
    } else {
      panel.style.bottom = '';
      panel.style.top = `${Math.round(rect.bottom + 6)}px`;
    }
  }

  function makeRow(title, subtitle, onClick) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = title;
    row.appendChild(name);

    if (subtitle) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = subtitle;
      row.appendChild(sub);
    }

    row.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return row;
  }

  async function renderPanel() {
    const data = await matches(true);
    panel.textContent = '';

    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = 'Keyring';
    panel.appendChild(head);

    if (!data || data.locked) {
      panel.appendChild(
        makeRow('Unlock Keyring', 'Enter your master password to fill', () => {
          KEYRING.send(KEYRING.MSG.OPEN_POPUP).catch(() => {});
          closeMenu();
        }),
      );
      return;
    }

    if (data.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No logins saved for this site.';
      panel.appendChild(empty);
    }

    for (const item of data.items) {
      panel.appendChild(
        makeRow(item.name, item.username || 'No username', () => fill(item.id)),
      );
    }

    const passwordFieldFocused = anchorField && anchorField.type === 'password';
    if (passwordFieldFocused) {
      const separator = document.createElement('div');
      separator.className = 'sep';
      panel.appendChild(separator);
      panel.appendChild(
        makeRow('Generate a password', 'Strong, random, filled in for you', async () => {
          closeMenu();
          const response = await KEYRING.send(KEYRING.MSG.GEN_PASSWORD, { options: {} });
          if (response && response.password) {
            KEYRING.autofill.fillGenerated(response.password, anchorField);
          }
        }),
      );
    }
  }

  async function fill(itemId) {
    closeMenu();
    try {
      const credential = await KEYRING.send(KEYRING.MSG.CREDENTIAL, {
        itemId,
        url: location.href,
      });
      if (credential) {
        KEYRING.autofill.fillGroup(
          anchorGroup || KEYRING.detect.groupForField(anchorField),
          credential,
        );
      }
    } catch (error) {
      KEYRING.savePrompt.toast(error.message);
    }
  }

  async function openMenu() {
    ensureHost();
    open = true;
    panel.style.display = 'block';
    positionPanel();
    await renderPanel();
    positionPanel();
  }

  function closeMenu() {
    open = false;
    if (panel) panel.style.display = 'none';
  }

  function toggle() {
    if (open) closeMenu();
    else openMenu();
  }

  KEYRING.inlineMenu = {
    showIconFor,
    hideIcon,
    positionIcon,
    openMenu,
    closeMenu,
    get isOpen() {
      return open;
    },
    get anchorField() {
      return anchorField;
    },
  };
})();
