// Login form discovery.
//
// The shape we are looking for: one visible password field, plus the nearest
// plausible username field ahead of it in document order. Sites that split login
// across two screens show up as a username-only group, which main.js pairs with
// the password step through the service worker.

(() => {
  const TEXT_TYPES = ['text', 'email', 'tel', 'url', ''];

  const USERNAME_HINTS = /user|email|e-mail|login|account|identifi|signin|handle|phone|mobile/;
  const NOT_USERNAME_HINTS = /search|query|coupon|promo|zip|postal|address|city|card|cvv|amount|quantity/;
  const OTP_HINTS = /otp|one-?time|2fa|two-?factor|totp|auth(?:entication)?code|verification|verify|security ?code|passcode/;

  function isTextish(input) {
    const type = (input.getAttribute('type') || '').toLowerCase();
    return TEXT_TYPES.includes(type) && !input.isContentEditable;
  }

  function documentOrder(a, b) {
    const position = a.compareDocumentPosition(b);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  // A <form> when there is one; otherwise the closest ancestor that also holds a
  // text input, which is how most modern login widgets are built.
  function scopeFor(element) {
    if (element.form) return element.form;
    const form = element.closest('form');
    if (form) return form;

    let node = element.parentElement;
    for (let depth = 0; node && depth < 6; depth++) {
      const inputs = node.querySelectorAll('input');
      if (inputs.length > 1) return node;
      node = node.parentElement;
    }
    return element.getRootNode() instanceof ShadowRoot
      ? element.getRootNode()
      : element.ownerDocument.body || element.ownerDocument;
  }

  function scoreUsername(input, passwordField) {
    const text = KEYRING.attributeText(input);
    if (NOT_USERNAME_HINTS.test(text)) return -1;

    let score = 0;
    const autocomplete = (input.getAttribute('autocomplete') || '').toLowerCase();
    if (autocomplete.includes('username')) score += 60;
    if (autocomplete.includes('email')) score += 40;
    if ((input.getAttribute('type') || '').toLowerCase() === 'email') score += 30;
    if (USERNAME_HINTS.test(text)) score += 25;

    if (passwordField) {
      // Prefer whatever sits immediately above the password box.
      const before = documentOrder(input, passwordField) === -1;
      if (!before) score -= 30;
      const gap = Math.abs(
        input.getBoundingClientRect().top - passwordField.getBoundingClientRect().top,
      );
      score += Math.max(0, 20 - gap / 20);
    }
    return score;
  }

  function isOtpField(input) {
    const autocomplete = (input.getAttribute('autocomplete') || '').toLowerCase();
    if (autocomplete.includes('one-time-code')) return true;
    if (!isTextish(input) && (input.getAttribute('type') || '') !== 'number') return false;
    const maxLength = Number(input.getAttribute('maxlength') || 0);
    if (maxLength && maxLength > 10) return false;
    return OTP_HINTS.test(KEYRING.attributeText(input));
  }

  function collectGroups() {
    const passwords = KEYRING.queryAll('input[type="password"]').filter(KEYRING.isVisible);
    const textInputs = KEYRING.queryAll('input').filter(
      (input) => isTextish(input) && KEYRING.isVisible(input),
    );

    const groups = [];
    const claimed = new Set();

    for (const passwordField of passwords) {
      if (claimed.has(passwordField)) continue;
      const scope = scopeFor(passwordField);

      const scopedPasswords = passwords.filter(
        (field) => scope.contains && scope.contains(field) ? true : field === passwordField,
      );
      scopedPasswords.forEach((field) => claimed.add(field));

      const inScope = textInputs.filter((input) =>
        scope.contains ? scope.contains(input) : true,
      );
      const scored = inScope.map((input) => ({
        input,
        score: scoreUsername(input, passwordField),
      }));

      const candidates = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);

      // A username box with no useful name, id, type or label scores nothing, so
      // scoring alone would leave the field unfound and the captured login with
      // no username. Fall back to the nearest text input above the password, as
      // long as it was not ruled out as a search or promo box.
      const fallback = scored
        .filter((entry) => entry.score > -1 && documentOrder(entry.input, passwordField) === -1)
        .pop();

      groups.push({
        kind: scopedPasswords.length > 1 ? 'change' : 'login',
        scope,
        usernameField: candidates.length
          ? candidates[0].input
          : fallback
            ? fallback.input
            : null,
        passwordField,
        extraPasswordFields: scopedPasswords.filter((field) => field !== passwordField),
        otpField: findOtp(scope),
      });
    }

    if (groups.length === 0) {
      // Username-only first step, or a standalone 2FA screen.
      const otpField = findOtp(document);
      const usernameCandidates = textInputs
        .map((input) => ({ input, score: scoreUsername(input, null) }))
        .filter((entry) => entry.score >= 25)
        .sort((a, b) => b.score - a.score);

      if (otpField) {
        groups.push({
          kind: 'otp',
          scope: scopeFor(otpField),
          usernameField: null,
          passwordField: null,
          extraPasswordFields: [],
          otpField,
        });
      } else if (usernameCandidates.length) {
        const usernameField = usernameCandidates[0].input;
        groups.push({
          kind: 'username-only',
          scope: scopeFor(usernameField),
          usernameField,
          passwordField: null,
          extraPasswordFields: [],
          otpField: null,
        });
      }
    }

    return groups;
  }

  function findOtp(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const inputs = KEYRING.queryAll('input', scope).filter(KEYRING.isVisible);
    return inputs.find(isOtpField) || null;
  }

  // focusin fires often and collectGroups walks the whole tree including shadow
  // roots, so the result is reused for a moment.
  let cached = { at: 0, groups: null };

  function collectGroupsCached() {
    if (cached.groups && Date.now() - cached.at < 500) return cached.groups;
    cached = { at: Date.now(), groups: collectGroups() };
    return cached.groups;
  }

  KEYRING.detect = {
    collectGroups: collectGroupsCached,
    collectGroupsNow: collectGroups,
    isOtpField,
    isTextish,
    scopeFor,
    // The group that owns a given field, so clicking the icon fills the right form.
    groupForField(field, groups = collectGroupsCached()) {
      return (
        groups.find(
          (group) =>
            group.passwordField === field ||
            group.usernameField === field ||
            group.otpField === field ||
            group.extraPasswordFields.includes(field),
        ) || groups[0] || null
      );
    },
    // Fields worth showing the inline icon on.
    fillableFields(groups = collectGroupsCached()) {
      const fields = [];
      for (const group of groups) {
        if (group.usernameField) fields.push(group.usernameField);
        if (group.passwordField) fields.push(group.passwordField);
        if (group.otpField) fields.push(group.otpField);
      }
      return fields;
    },
  };
})();
