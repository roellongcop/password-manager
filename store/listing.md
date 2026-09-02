# Chrome Web Store submission

Everything the dashboard asks for, written out so it can be pasted straight in.
Build the upload with `node tools/package.js` → `dist/keyring-<version>.zip`.

---

## Before you start

1. **Register as a developer** at <https://chrome.google.com/webstore/devconsole>.
   One-off $5 fee, paid once for the account, not per extension.
2. **Host the privacy policy.** `store/PRIVACY.md` needs to live at a public URL
   before you submit — a public GitHub repo, GitHub Pages, or a gist is enough.
   The dashboard will not accept a submission without it for an extension that
   handles credentials.
3. **Decide on visibility.** *Unlisted* is almost certainly what you want: the
   extension installs from a link, updates automatically, does not need Developer
   mode, and never appears in search results. It still goes through the same
   review as a public listing.

---

## Store listing

**Name**

```
Keyring — Local Password Manager
```

Check the store for an existing extension called Keyring before you commit to it.
Duplicate names are allowed but a confusingly similar one can be grounds for
rejection, and the name is hard to change later.

**Short description** (132 characters max; the manifest `description` field is used
if you leave this alone)

```
Local-only password manager. Encrypted vault, autofill, generator, TOTP. No account, no server, no sync.
```

**Category:** Productivity — **Language:** English

**Detailed description**

```
Keyring is a password manager that never leaves your computer.

Your vault is a single file, encrypted with AES-256-GCM under a key derived from
your master password (PBKDF2-SHA-256, 600,000 iterations). It is stored in your own
browser profile. There is no account to create, no server to trust, and no sync.
The extension makes no network requests at all.

WHAT IT DOES

• Autofill — Keyring finds the login form, and fills it when you click its icon in
  the field or press Ctrl+Shift+L. Nothing is ever filled automatically on page
  load.
• Save prompts — sign in as usual and Keyring offers to save the credential, or to
  update it when a password changes.
• Password generator — random passwords with the character classes you choose, or
  passphrases drawn from a 2,300-word list, with the entropy shown as you adjust it.
• Two-factor codes — store TOTP secrets and get rolling codes in the popup, filled
  into the one-time-code field alongside the password.
• Secure notes and payment cards — encrypted like everything else, masked until you
  reveal them, and copied by hand rather than typed into pages.
• Import and export — a documented CSV format, a column-mapping importer for any
  other CSV, and an encrypted backup file that only your master password opens.

HOW IT IS PROTECTED

• The master password is never stored, in any form.
• While unlocked, the key lives only in memory, and is discarded when the browser
  closes or the idle timer fires.
• Sites are matched on their registrable domain, so a credential saved for
  paypal.com is invisible to evil-paypal.com.
• A web page never receives your vault or a list of your items. It receives one
  credential, for one item you picked, after Keyring has confirmed that item is
  saved for that exact site.
• Filling on unencrypted http:// pages is refused unless you enable it for a
  specific item.

There is no password recovery. Nobody, including the author, can open your vault
without your master password. Export a backup and keep it somewhere safe.
```

---

## Screenshots

At least one, up to five. **1280×800** (or 640×400), PNG or JPEG, no alpha channel,
no browser chrome around the edges — crop to the extension itself. Worth showing:

1. The popup, unlocked, with a couple of logins listed for the current site.
2. The item editor in the options page.
3. The generator tab with the entropy meter.
4. The inline dropdown open on a real login form.
5. The settings page.

Use a vault of made-up entries. Anything legible in a screenshot is public.

---

## Privacy practices tab

**Single purpose**

```
Keyring is a password manager. It stores the user's credentials in an encrypted
vault on their own device and fills them into login forms at the user's request.
```

**Permission justifications** — one box each, exact text to paste:

`storage`
```
Holds the encrypted vault and the extension's settings in the user's own browser
profile. The unlock key is kept in session storage, which is memory-only and
cleared when the browser closes. Nothing is written anywhere else.
```

`alarms`
```
Runs the idle auto-lock timer and the delayed clipboard clear. Both are time-based
and cannot be scheduled reliably from an event-driven service worker without alarms.
```

`contextMenus`
```
Adds right-click entries to fill a saved login, generate a password into the focused
field, and lock the vault.
```

`offscreen`
```
Overwrites the clipboard a configurable number of seconds after the user copies a
password, so it does not sit there indefinitely. A service worker has no DOM, so
the clipboard write needs a short-lived offscreen document.
```

**Host permission** `<all_urls>`
```
The extension must detect login forms and fill credentials on whichever sites the
user has saved a login for. Those sites are chosen entirely by the user and are not
known in advance, so no narrower set of match patterns is possible. On a page the
content script reads only login form fields in order to fill or capture them, and
no page content is transmitted anywhere — the extension makes no network requests.

This permission also covers tabs.captureVisibleTab, which is used for one thing:
when the user presses "Scan QR on this page" to add a two-factor code. The
screenshot is decoded inside the extension, only the otpauth:// link found in it is
kept, and the image is never stored or sent anywhere. Nothing is captured unless
the user presses that button.
```

**Remote code:** No, the extension does not use remote code. All JavaScript is
included in the package.

**Data usage** — the form asks what the item *collects*, meaning transmits off the
device. Keyring transmits nothing, so every box is unticked, including
authentication information and financial information. The vault stays on the user's
machine and the developer has no access to it.

Then tick all three certifications: no sale of data, no use or transfer for
unrelated purposes, no use or transfer for creditworthiness or lending.

**Privacy policy URL:** the public URL where you hosted `store/PRIVACY.md`.

---

## What to expect from review

A password manager asking for `<all_urls>` is one of the more heavily scrutinised
combinations there is. Expect days rather than hours, and possibly a request for
clarification — the permission justifications above are written to answer the usual
questions up front. Rejections at this stage are normally about incomplete
justifications rather than the code.

Once published, every subsequent change means bumping `version` in `manifest.json`,
re-running `node tools/package.js`, uploading the new ZIP and waiting for another
review. Keep the unpacked copy loaded for development.
