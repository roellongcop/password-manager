// Login form discovery.
//
// The shape we are looking for: one visible password field, plus the nearest
// plausible username field ahead of it in document order. Sites that split login
// across two screens show up as a username-only group, which main.js pairs with
// the password step through the service worker.

(() => {
  const TEXT_TYPES = ['text', 'email', 'tel', 'url', ''];

  // A login box is called a lot of things. English first, then the words the
  // same field carries on non-English sites.
  const USERNAME_HINTS =
    /user|uname|usr\b|login|logon|signin|sign-in|account|acct|member|customer|subscriber|identifi|ident\b|handle|nick|alias|screen ?name|display ?name|email|e-mail|mail|phone|mobile|msisdn|usuario|utilisateur|identifiant|courriel|benutzer|nutzer|anwender|kennung|gebruiker|utente|utilizador|usuário|用户|使用者|帳號|账号|ユーザ|사용자|아이디|логин|пользовател/;

  // An exact field name is a much stronger signal than the word appearing
  // somewhere in a label, and it is what tells a real username box apart from a
  // "search by username" box.
  const USERNAME_NAMES = new Set([
    'user',
    'username',
    'user_name',
    'username1',
    'userid',
    'user_id',
    'uname',
    'usr',
    'login',
    'loginid',
    'login_id',
    'login_name',
    'loginname',
    'j_username',
    'account',
    'accountname',
    'account_name',
    'email',
    'emailaddress',
    'email_address',
    'e-mail',
    'mail',
    'identifier',
    'identity',
    'handle',
    'nickname',
    'member',
    'memberid',
    'customerid',
    'usuario',
    'utilisateur',
    'benutzername',
    'gebruikersnaam',
  ]);

  // Deliberately not a bare "address": "Email address" is the single most common
  // label a login field has, and vetoing it threw away the field entirely.
  const NOT_USERNAME_HINTS =
    /search|query|coupon|promo|zip|postcode|postal|street|billing|shipping|city|county|card ?number|cvv|amount|quantity/;
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

  const EMAIL_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+.[A-Za-z0-9.-]+/;

  // Who the second step of a login belongs to, when the page shows it instead of
  // asking for it. Picking an account from a chooser, or "Welcome back, ada@..",
  // leaves no field to read and nothing typed -- so without this the capture is a
  // password with no owner.
  //
  // Only email-shaped text counts. A bare username on screen is indistinguishable
  // from a greeting or a heading, and guessing wrong puts the wrong name on a
  // saved password.
  function displayedIdentifier(group) {
    if (!group || !group.passwordField || group.usernameField) return '';

    // The site's own record of who is signing in, if it kept one in the form.
    const root = group.scope && group.scope.querySelectorAll ? group.scope : document;
    for (const hidden of root.querySelectorAll('input[type="hidden"]')) {
      const value = (hidden.value || '').trim();
      if (value.length > 120 || !EMAIL_TEXT.test(value)) continue;
      if (USERNAME_HINTS.test(KEYRING.attributeText(hidden))) return value;
    }

    // Otherwise read it off the screen, starting at the form and widening a
    // couple of levels. Staying near the password field keeps a support address
    // in the footer out of it.
    let node = root.nodeType === 1 ? root : document.body;
    for (let depth = 0; node && depth < 3; depth++) {
      const match = (node.innerText || node.textContent || '').match(EMAIL_TEXT);
      if (match) return match[0];
      node = node.parentElement;
    }
    return '';
  }

  function scoreUsername(input, passwordField) {
    const text = KEYRING.attributeText(input);

    let score = 0;
    const autocomplete = (input.getAttribute('autocomplete') || '').toLowerCase();
    if (autocomplete.includes('username')) score += 60;
    if (autocomplete.includes('email')) score += 40;

    // An exactly-named field outranks anything inferred from surrounding words.
    const named = (attribute) =>
      USERNAME_NAMES.has(
        (input.getAttribute(attribute) || '').trim().toLowerCase().replace(/[[\]]/g, ''),
      );
    if (named('name') || named('id') || named('data-auth-field')) score += 50;

    const type = (input.getAttribute('type') || '').toLowerCase();
    if (type === 'email') score += 30;
    if (type === 'tel') score += 10;
    if (USERNAME_HINTS.test(text)) score += 25;

    // The veto only applies when nothing positive was found. A field that says
    // it is a username -- by type, autocomplete or name -- is one, whatever else
    // its label happens to mention.
    if (score === 0 && NOT_USERNAME_HINTS.test(text)) return -1;

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
    displayedIdentifier,
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
