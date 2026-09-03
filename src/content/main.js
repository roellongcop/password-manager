// Wiring: focus tracking, the fill shortcut, and credential capture.

(() => {
  if (window.__keyringLoaded) return;
  window.__keyringLoaded = true;

  // What the user has actually typed, kept so a form that clears itself on submit
  // can still be captured.
  const typed = { username: '', password: '', at: 0 };
  let lastOffered = '';
  let rafPending = false;

  // ------------------------------------------------------------------ focus

  function fillableFor(element) {
    if (!element || element.tagName !== 'INPUT') return null;
    const groups = KEYRING.detect.collectGroups();
    const fields = KEYRING.detect.fillableFields(groups);
    if (!fields.includes(element)) return null;
    return { group: KEYRING.detect.groupForField(element, groups), groups };
  }

  document.addEventListener(
    'focusin',
    (event) => {
      const match = fillableFor(event.target);
      if (!match) return KEYRING.inlineMenu.hideIcon();
      KEYRING.inlineMenu.showIconFor(event.target, match.group);
    },
    true,
  );

  document.addEventListener(
    'focusout',
    () => {
      // Give the click on the icon a chance to land before tearing it down.
      setTimeout(() => {
        const active = document.activeElement;
        if (!active || !fillableFor(active)) {
          if (!KEYRING.inlineMenu.isOpen) KEYRING.inlineMenu.hideIcon();
        }
      }, 180);
    },
    true,
  );

  document.addEventListener(
    'click',
    (event) => {
      if (KEYRING.inlineMenu.isOpen && event.target !== KEYRING.inlineMenu.anchorField) {
        KEYRING.inlineMenu.closeMenu();
      }
    },
    true,
  );

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && KEYRING.inlineMenu.isOpen) KEYRING.inlineMenu.closeMenu();
  });

  function reposition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      KEYRING.inlineMenu.positionIcon();
    });
  }
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition, true);

  // ----------------------------------------------------------------- capture

  document.addEventListener(
    'input',
    (event) => {
      const field = event.target;
      if (!field || field.tagName !== 'INPUT') return;
      if (field.type === 'password') {
        typed.password = field.value;
        typed.at = Date.now();
      } else if (KEYRING.detect.isTextish(field)) {
        const group = KEYRING.detect.groupForField(field);
        if (group && group.usernameField === field) {
          typed.username = field.value;
          typed.at = Date.now();
          // No password on this screen: it is the first step of a two-step login.
          if (!group.passwordField) rememberTyped();
        }
      }
    },
    true,
  );

  function readCurrent() {
    const groups = KEYRING.detect.collectGroups();
    const group =
      groups.find((entry) => entry.passwordField && entry.passwordField.value) || null;

    const password = group ? group.passwordField.value : typed.password;
    const username = group && group.usernameField && group.usernameField.value
      ? group.usernameField.value
      : typed.username;

    // Nothing typed and no field to read: the account was picked from a list, so
    // the page is showing who this password belongs to rather than asking.
    if (!username && group) {
      return { username: KEYRING.detect.displayedIdentifier(group), password: password || '' };
    }

    return { username: username || '', password: password || '' };
  }

  async function offerCapture(reason) {
    const { username, password } = readCurrent();
    if (!password || password.length < 3) return;

    const key = `${username}\n${password}`;
    if (key === lastOffered) return;
    lastOffered = key;

    try {
      await KEYRING.send(KEYRING.MSG.CAPTURE_OFFER, {
        username,
        password,
        url: location.href,
        reason,
      });
    } catch {
      // Vault locked or worker restarting; the offer is held for the popup.
    }
  }

  // Two-step logins navigate the moment Next is clicked, and a message sent from
  // that handler can be dropped as the page goes away. The username is therefore
  // also remembered while it is being typed, which is what makes Gmail and the
  // like save a username rather than a lone password.
  const rememberTyped = KEYRING.debounce(() => {
    if (!typed.username) return;
    KEYRING.send('capture:username', { username: typed.username }).catch(() => {});
  }, 600);

  // A username-only step: remember it so the password step can be attributed.
  async function rememberUsername() {
    const groups = KEYRING.detect.collectGroups();
    const step = groups.find((group) => group.kind === 'username-only' && group.usernameField);
    const value = step ? step.usernameField.value : '';
    if (!value) return;
    try {
      await KEYRING.send('capture:username', { username: value });
    } catch {
      // Not fatal.
    }
  }

  document.addEventListener(
    'submit',
    () => {
      rememberUsername();
      offerCapture('submit');
    },
    true,
  );

  const SUBMITISH = /log ?in|sign ?in|sign ?on|submit|continue|next|masuk|entrar|connexion|anmelden/i;

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      const control = target.closest('button, input[type="submit"], [role="button"], a');
      if (!control) return;

      const label = (control.value || control.textContent || control.getAttribute('aria-label') || '')
        .trim()
        .slice(0, 40);
      const isSubmit =
        control.type === 'submit' ||
        (control.tagName === 'BUTTON' && !control.type) ||
        control.type === 'button' ||
        SUBMITISH.test(label);
      if (!isSubmit) return;

      rememberUsername();
      // Let the site clear or navigate first; read again once it settles.
      setTimeout(() => offerCapture('click'), 400);
    },
    true,
  );

  window.addEventListener('pagehide', () => offerCapture('pagehide'));

  // SPA logins: the form is torn out of the DOM instead of navigating.
  const observer = new MutationObserver(
    KEYRING.debounce(() => {
      const passwordFields = KEYRING.queryAll('input[type="password"]').filter(KEYRING.isVisible);
      if (typed.password && passwordFields.length === 0 && Date.now() - typed.at < 60000) {
        offerCapture('detached');
      }
      const active = document.activeElement;
      if (active && fillableFor(active)) KEYRING.inlineMenu.positionIcon();
    }, 400),
  );
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Route changes in single-page apps invalidate the cached match list.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastOffered = '';
      KEYRING.invalidateMatches();
      KEYRING.inlineMenu.hideIcon();
    }
  }, 1000);

  // ---------------------------------------------------------------- messages

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      switch (message?.type) {
        case KEYRING.MSG.TRIGGER: {
          const data = await KEYRING.send(KEYRING.MSG.MATCHES, { url: location.href });
          const groups = KEYRING.detect.collectGroups();
          const target =
            (document.activeElement && fillableFor(document.activeElement)
              ? document.activeElement
              : null) ||
            (groups[0] && (groups[0].usernameField || groups[0].passwordField));

          if (!target) return sendResponse({ ok: false });
          if (!data || data.locked) {
            KEYRING.inlineMenu.showIconFor(target, groups[0]);
            KEYRING.inlineMenu.openMenu();
            return sendResponse({ ok: true });
          }
          if (data.items.length === 1) {
            const credential = await KEYRING.send(KEYRING.MSG.CREDENTIAL, {
              itemId: data.items[0].id,
              url: location.href,
            });
            KEYRING.autofill.fillGroup(groups[0], credential);
            return sendResponse({ ok: true });
          }
          KEYRING.inlineMenu.showIconFor(target, groups[0]);
          KEYRING.inlineMenu.openMenu();
          return sendResponse({ ok: true });
        }

        case KEYRING.MSG.APPLY:
          KEYRING.autofill.fillBest(message.credential);
          return sendResponse({ ok: true });

        case KEYRING.MSG.GENERATE: {
          const response = await KEYRING.send(KEYRING.MSG.GEN_PASSWORD, { options: {} });
          if (response?.password) {
            KEYRING.autofill.fillGenerated(response.password);
            KEYRING.savePrompt.toast('Generated password filled in.');
          }
          return sendResponse({ ok: true });
        }

        case KEYRING.MSG.SELECT_REGION: {
          // Only the top frame draws the overlay; the coordinates it returns are
          // viewport-relative, which is what the screenshot is too.
          if (!KEYRING.isTopFrame) return sendResponse({ ignored: true });
          const result = await KEYRING.regionSelect.selectRegion();
          return sendResponse(result);
        }

        case KEYRING.MSG.TOAST:
          KEYRING.savePrompt.toast(message.text);
          return sendResponse({ ok: true });

        case KEYRING.MSG.CAPTURE_PROMPT:
          KEYRING.savePrompt.show(message);
          return sendResponse({ ok: true });

        case 'state:changed':
        case 'state:locked':
        case 'state:unlocked':
          KEYRING.invalidateMatches();
          return sendResponse({ ok: true });

        default:
          return sendResponse({ ok: false });
      }
    })().catch((error) => {
      KEYRING.savePrompt.toast(error.message);
      sendResponse({ error: error.message });
    });
    return true;
  });
})();
