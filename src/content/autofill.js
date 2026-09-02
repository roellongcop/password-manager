// Applying a credential to a detected form.

(() => {
  function fillGroup(group, credential) {
    if (!group) return { filled: false };
    let filled = false;

    if (group.usernameField && credential.username) {
      KEYRING.setValue(group.usernameField, credential.username);
      KEYRING.flash(group.usernameField);
      filled = true;
    }

    if (group.passwordField && credential.password) {
      KEYRING.setValue(group.passwordField, credential.password);
      KEYRING.flash(group.passwordField);
      filled = true;
    }

    if (group.otpField && credential.totp) {
      KEYRING.setValue(group.otpField, credential.totp);
      KEYRING.flash(group.otpField);
      filled = true;
    }

    // Leave focus where a person would leave it: on the first empty field, or on
    // the password so Enter submits.
    const focusTarget = group.passwordField || group.usernameField || group.otpField;
    if (focusTarget) {
      try {
        focusTarget.focus();
      } catch {
        // Field removed mid-fill.
      }
    }
    KEYRING.lastFilled = { at: Date.now(), username: credential.username || '' };
    return { filled };
  }

  // Fill the best group on the page. Used by the keyboard shortcut and the popup.
  function fillBest(credential) {
    const groups = KEYRING.detect.collectGroups();
    if (!groups.length) return { filled: false };

    const focused = document.activeElement;
    const preferred =
      (focused && KEYRING.detect.groupForField(focused, groups)) ||
      groups.find((group) => group.passwordField) ||
      groups[0];
    return fillGroup(preferred, credential);
  }

  // Context-menu generator: write into the focused password field and mirror it
  // into any confirmation field beside it.
  function fillGenerated(password, target) {
    const field = target || document.activeElement;
    if (!field || field.tagName !== 'INPUT') return { filled: false };

    KEYRING.setValue(field, password);
    KEYRING.flash(field);

    const group = KEYRING.detect.groupForField(field);
    if (group) {
      for (const confirmation of group.extraPasswordFields) {
        if (confirmation !== field) {
          KEYRING.setValue(confirmation, password);
          KEYRING.flash(confirmation);
        }
      }
      if (group.passwordField && group.passwordField !== field && field.type === 'password') {
        KEYRING.setValue(group.passwordField, password);
      }
    }
    // setValue focuses each field it writes; put the caret back where it was.
    try {
      field.focus();
    } catch {
      // Field removed mid-fill.
    }
    return { filled: true };
  }

  KEYRING.autofill = { fillGroup, fillBest, fillGenerated };
})();
