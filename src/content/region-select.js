// Drag a box around the QR code you want read.
//
// The popup closes the moment you click into the page, so this cannot report back
// to it. The service worker asks for a region, waits for the answer, then captures
// and decodes on its own and toasts the result here.

(() => {
  let host = null;
  let root = null;
  let pending = null;

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
    .sheet {
      position: fixed; inset: 0; z-index: 2147483647;
      cursor: crosshair;
    }
    /* Four panels dim everything except the selection, so the box itself stays
       perfectly clear -- a translucent overlay on top would tint the QR and can
       cost us the contrast we need to read it. */
    .shade { position: fixed; background: rgba(15, 23, 42, .45); }
    .box {
      position: fixed; border: 1.5px solid #ffffff;
      box-shadow: 0 0 0 1.5px rgba(15,23,42,.55);
      pointer-events: none; display: none;
    }
    .hint {
      position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
      background: #171b21; color: #f4f6f8;
      border-radius: 999px; padding: 9px 18px;
      font-size: 13px; font-weight: 500; white-space: nowrap;
      box-shadow: 0 8px 26px rgba(0,0,0,.35);
    }
    .hint b { color: #7fd0a6; font-weight: 600; }
  `;

  function build() {
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;';
    root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = STYLES;

    const sheet = document.createElement('div');
    sheet.className = 'sheet';

    const shades = ['top', 'right', 'bottom', 'left'].map(() => {
      const shade = document.createElement('div');
      shade.className = 'shade';
      return shade;
    });

    const box = document.createElement('div');
    box.className = 'box';

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.innerHTML = 'Drag a box around the QR code &nbsp;·&nbsp; <b>Esc</b> to cancel';

    root.append(style, sheet, ...shades, box, hint);
    (document.documentElement || document.body).appendChild(host);
    return { sheet, shades, box, hint };
  }

  function layoutShades(shades, rect) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const area = rect || { left: 0, top: 0, width: 0, height: 0 };
    const right = area.left + area.width;
    const bottom = area.top + area.height;

    const place = (shade, left, top, w, h) => {
      shade.style.left = `${Math.max(0, left)}px`;
      shade.style.top = `${Math.max(0, top)}px`;
      shade.style.width = `${Math.max(0, w)}px`;
      shade.style.height = `${Math.max(0, h)}px`;
    };

    if (!rect) {
      place(shades[0], 0, 0, width, height);
      for (let i = 1; i < 4; i++) place(shades[i], 0, 0, 0, 0);
      return;
    }
    place(shades[0], 0, 0, width, area.top);
    place(shades[1], right, area.top, width - right, area.height);
    place(shades[2], 0, bottom, width, height - bottom);
    place(shades[3], 0, area.top, area.left, area.height);
  }

  function finish(result) {
    if (!pending) return;
    const resolve = pending;
    pending = null;
    window.removeEventListener('keydown', onKey, true);
    if (host) {
      host.remove();
      host = null;
      root = null;
    }
    resolve(result);
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish({ cancelled: true });
    }
  }

  // Resolves with the chosen region in CSS pixels, plus the device pixel ratio so
  // the worker can map it onto the screenshot.
  function selectRegion() {
    if (pending) finish({ cancelled: true });

    return new Promise((resolve) => {
      pending = resolve;
      const { sheet, shades, box } = build();
      layoutShades(shades, null);

      let start = null;

      const rectFrom = (event) => {
        const left = Math.min(start.x, event.clientX);
        const top = Math.min(start.y, event.clientY);
        return {
          left,
          top,
          width: Math.abs(event.clientX - start.x),
          height: Math.abs(event.clientY - start.y),
        };
      };

      sheet.addEventListener('mousedown', (event) => {
        event.preventDefault();
        start = { x: event.clientX, y: event.clientY };
        box.style.display = 'block';
      });

      sheet.addEventListener('mousemove', (event) => {
        if (!start) return;
        const rect = rectFrom(event);
        box.style.left = `${rect.left}px`;
        box.style.top = `${rect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        layoutShades(shades, rect);
      });

      sheet.addEventListener('mouseup', (event) => {
        if (!start) return;
        const rect = rectFrom(event);
        // A click rather than a drag means "look at the whole page".
        const wholePage = rect.width < 12 || rect.height < 12;
        finish({
          rect: wholePage
            ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
            : rect,
          devicePixelRatio: window.devicePixelRatio || 1,
        });
      });

      window.addEventListener('keydown', onKey, true);
    });
  }

  KEYRING.regionSelect = { selectRegion };
})();
