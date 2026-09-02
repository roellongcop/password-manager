// The "save this login?" banner and the small toast used for errors.
// Same closed shadow root treatment as the inline menu.

(() => {
  let host = null;
  let root = null;
  let card = null;
  let toastEl = null;
  let toastTimer = 0;
  let current = null;

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
    .card, .toast {
      position: fixed; right: 16px; z-index: 2147483647;
      background: #ffffff; color: #101418;
      border: 1px solid #d8dee6; border-radius: 12px;
      box-shadow: 0 12px 34px rgba(15,23,42,.22);
      font-size: 13px; line-height: 1.4;
    }
    .card { top: 16px; width: 320px; padding: 14px; display: none; }
    .toast { bottom: 16px; padding: 10px 14px; max-width: 320px; display: none; }
    .title { font-weight: 650; font-size: 14px; margin: 0 0 4px; }
    .body { color: #4b5563; margin: 0 0 12px; word-break: break-word; }
    .row { display: flex; gap: 8px; align-items: center; }
    button {
      font: inherit; border-radius: 8px; padding: 7px 12px; cursor: pointer;
      border: 1px solid #d8dee6; background: #f4f6f8; color: #101418;
    }
    button.primary { background: #2f6f4f; border-color: #2f6f4f; color: #fff; font-weight: 600; }
    button.ghost { border-color: transparent; background: transparent; color: #5b6572; }
    button:hover { filter: brightness(0.97); }
    .spacer { flex: 1; }
    @media (prefers-color-scheme: dark) {
      .card, .toast { background: #171b21; color: #e8edf3; border-color: #2b323c; }
      .body { color: #98a2b3; }
      button { background: #232a33; border-color: #333c48; color: #e8edf3; }
      button.primary { background: #2f6f4f; border-color: #2f6f4f; color: #fff; }
      button.ghost { background: transparent; border-color: transparent; color: #98a2b3; }
    }
  `;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;';
    root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = STYLES;

    card = document.createElement('div');
    card.className = 'card';

    toastEl = document.createElement('div');
    toastEl.className = 'toast';

    root.append(style, card, toastEl);
    (document.documentElement || document.body).appendChild(host);
  }

  function button(label, className, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return element;
  }

  function show(details) {
    // Only the top frame gets to draw the banner, otherwise an iframe login shows
    // it twice or draws it inside a 200px box.
    if (!KEYRING.isTopFrame) return;
    ensureHost();
    current = details;
    card.textContent = '';

    const title = document.createElement('p');
    title.className = 'title';
    title.textContent =
      details.action === 'update' ? 'Update this password?' : 'Save this login?';
    card.appendChild(title);

    const body = document.createElement('p');
    body.className = 'body';
    const who = details.username || 'this account';
    body.textContent =
      details.action === 'update'
        ? `The password for ${who} on ${details.domain} has changed.`
        : `Keyring can save ${who} for ${details.domain}.`;
    card.appendChild(body);

    const row = document.createElement('div');
    row.className = 'row';
    row.appendChild(
      button(details.action === 'update' ? 'Update' : 'Save', 'primary', save),
    );
    row.appendChild(button('Not now', '', dismiss));
    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    row.appendChild(spacer);
    row.appendChild(button('Never here', 'ghost', never));
    card.appendChild(row);

    card.style.display = 'block';
  }

  async function save() {
    if (!current) return;
    try {
      // The password itself never travels back through the page: the service
      // worker still holds the pending capture and reads it from there.
      await KEYRING.send(KEYRING.MSG.CAPTURE_SAVE, {
        action: current.action,
        itemId: current.itemId,
      });
      toast(current.action === 'update' ? 'Password updated.' : 'Login saved.');
      KEYRING.invalidateMatches();
    } catch (error) {
      toast(error.message);
    }
    hide();
  }

  function dismiss() {
    KEYRING.send(KEYRING.MSG.CAPTURE_DISCARD).catch(() => {});
    hide();
  }

  async function never() {
    try {
      await KEYRING.send(KEYRING.MSG.CAPTURE_NEVER, { url: location.href });
      toast('Keyring will not ask about this site again.');
      KEYRING.invalidateMatches();
    } catch (error) {
      toast(error.message);
    }
    hide();
  }

  function hide() {
    current = null;
    if (card) card.style.display = 'none';
  }

  function toast(message) {
    if (!KEYRING.isTopFrame || !message) return;
    ensureHost();
    toastEl.textContent = message;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.style.display = 'none';
    }, 4000);
  }

  KEYRING.savePrompt = { show, hide, toast };
})();
