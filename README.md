# Keyring

A local-only password manager for Chrome, Edge and Brave. Encrypted vault, autofill,
save prompts, password generator, TOTP codes, secure notes and cards — no account,
no subscription, no third party involved.

Nothing leaves the machine unless you switch on **Sync**, which keeps the encrypted
vault in a Firebase project you own. Off by default; see [Sync](#sync).

## Install

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder.
4. The setup tab opens. Choose a master password.

Pin the toolbar icon so the popup is one click away.

## Everyday use

| Action | How |
| --- | --- |
| Open the vault | Click the icon, or `Ctrl+Shift+Space` |
| Fill the login on the current page | Click the icon inside the field, or `Ctrl+Shift+L` |
| Save a new login | Sign in as usual and answer the prompt |
| See your 2FA codes | **Codes** tab in the popup |
| Generate a password | Generator tab, or right-click a password field |
| Manage everything | **Manage** in the popup, or the extension's options page |
| Lock immediately | **Lock** in the popup, or right-click → Lock Keyring |

The badge on the toolbar icon shows how many saved logins match the current site.

Lists are ordered favourites first, then whatever you used most recently, then the
rest by name. Filling a login or copying a password or code counts as using it.
Click the star beside any item to favourite it; that saves straight away.

## Authenticator

Keyring is also a TOTP authenticator, so a separate 2FA extension is not needed.
Codes come in two shapes and both appear together under **Codes** in the popup,
ticking off one timer:

- A code attached to a login, filled alongside the password.
- A standalone entry (**Authenticator** in the sidebar, **Code** in the toolbar) for
  an account whose password lives somewhere else.

SHA-1/256/512, 6-8 digits and any period are supported; the defaults are what
almost every site uses. Paste an `otpauth://` link into the secret field and the
algorithm, digits, period, issuer and account are all read from it.

Three ways to add a code:

- **Scan QR on this page** in the popup Codes tab. The page dims and you drag a box
  around the QR code; click without dragging to search the whole visible page, or
  press Esc to cancel. Keyring crops its screenshot to that box, decodes it and
  saves the code, then confirms on the page itself. The screenshot is decoded
  inside the extension and never reaches the page.
- **A saved image**: pick one in the code editor itself, or in
  Manage -> Import & export, where a screenshot pasted with Ctrl+V works too.
- **By hand**, pasting the secret or the otpauth:// link.

A saved code goes the other way too: the editor shows it as a scannable otpauth QR,
updating as you edit, with **Download QR** to save it as a PNG. Use it to set the
same account up on a phone or a second authenticator. That QR carries the secret
itself, so treat the image like the secret.

QR reading and writing are both written from scratch in
[src/lib/qr.js](src/lib/qr.js) rather than pulled from a library, so nothing
third-party ships inside the vault. Versions 1 to 10 at any rotation, which covers
every authenticator QR; anything larger is reported rather than guessed at.

To move codes over from another authenticator, use
**Manage → Import & export → Import authenticator codes** and paste either
`otpauth://` links one per line, or the JSON an authenticator extension exports.
Duplicate secrets are skipped. `otpauth-migration://` links (the Google
Authenticator export format) are not supported — export individual links instead.

Give a standalone entry a website and its code fills the one-time-code field there,
the same way a login does.

## Sync

Sync is off until you switch it on, and it is the one thing here that touches the
network. Turned on, Keyring keeps the vault in a Firebase project **you** own, so a
second computer gets the same items.

What is uploaded is the encrypted blob and nothing else — the same file the
extension keeps on disk, plus a revision number and the name of the machine that
wrote it. Encryption and decryption happen locally, the master password never
leaves the machine, and Google (or anyone else who reaches the document) sees one
opaque string.

It speaks the Firebase REST API with plain `fetch`. The Firebase SDK is not
bundled: a password manager should not ship a large third-party library it has
never read, and MV3 forbids loading one at runtime anyway.

Setting it up — the full steps are on **Manage → Sync**:

1. Create a Firebase project, enable Email/Password authentication and Firestore.
2. Replace the Firestore rules with the ones shown on that page. They are what
   stops anyone but you reading the document.
3. Register a Web app in the project and paste its `apiKey` and `projectId` in.
4. Create the sync account. **Use a different password from the master password** —
   this one is checked by Google, and the master password must never be.

On the second computer, install Keyring, enter the same project details, sign in
with the same sync account, then use **Open the synced vault** and give it the
master password once. A vault made locally has its own random salt, so that first
download is what puts both machines on one file.

Saving uploads: a few seconds after any change the encrypted file goes up on its
own. Downloading is manual — press **Sync now** on the Sync page to take what
another machine has published. An automatic download would replace what you had
just typed, so it waits to be asked. An upload that finds the server already ahead
stops, and the page says so.

The copy on the server wins. If this machine has edits that never uploaded and the
other one has published since, those edits are replaced and the manager says so.
One rule, no prompt — and the cost of it is that unsent changes can be lost, so
take a backup before working offline on two machines at once.

## Import and export

Keyring has its own CSV format. These are the columns, in the order the exporter
writes them:

```
type,name,folder,favorite,username,password,url,totp,notes,cardholder,number,expMonth,expYear,cvv
```

`type` is `login`, `note`, `card` or `totp`; leave it blank and Keyring works it out from
what the row contains. `favorite` is `true` or empty. Only the columns you actually
use need to be present. The `totp` column takes a bare base32 secret, or a whole
`otpauth://` link when the code uses a non-default algorithm, digit count or period.

**Manage → Import & export → Download a blank template** gives you that header plus
one example of each item type, ready to fill in with a spreadsheet or a text editor
and import back.

Any other CSV imports too. If its headings are recognisable (title, login, secret,
web site, category and similar) they are matched automatically; anything else starts
as *Ignore* and you say what each column holds. Nothing is ever guessed from column
position — an unmapped column is simply not imported. A file with no header row at
all works once you untick **First row is a header** and map the columns by hand.

Importing merges into the vault. A row whose site and username already exist is
skipped rather than duplicated.

## Backups

**Manage → Import & export → Download encrypted backup** writes the same encrypted
blob the extension stores internally. It is useless without the master password, so
it is safe to keep in a sync folder or on a USB stick.

Restoring replaces the whole vault. There is also a plain-CSV export behind a
confirmation — it holds every password in readable text, so delete it as soon as
you are done with it.

**Test the backup before you trust the vault:** export, delete the vault
(Manage → Master password → Delete this vault), restore from the file, confirm
everything came back.

## How it is protected

- Master password → PBKDF2-SHA-256, 600,000 iterations, 16-byte random salt → a
  256-bit key.
- The whole vault is encrypted with AES-256-GCM under that key, with a fresh IV on
  every write. A wrong password fails as a GCM authentication error; there is no
  separate verifier hash to attack.
- The master password is never stored. The key lives in `chrome.storage.session`
  (memory only, never written to disk, unreachable from web pages) and disappears
  when the browser closes or the idle timer fires.
- Sites are matched on the registrable domain, so `evil-paypal.com` can never see a
  credential saved for `paypal.com`.
- A page never receives the vault. It receives one credential, for one item you
  picked, after the extension has confirmed that item is saved for that exact site.
- Nothing is filled automatically on page load — filling always takes a click or the
  keyboard shortcut.
- Sync, when on, uploads only the encrypted blob. The key is never derived anywhere
  but on your own machine, and a downloaded vault is refused unless it opens with
  the key already in memory.
- Filling on `http://` pages is allowed by default but can be turned off per item;
  `localhost` counts as secure either way, since that traffic never leaves the machine.

The one thing this design cannot survive is a forgotten master password. There is no
recovery, by design.

## Layout

```
manifest.json            MV3 manifest
src/lib/                 crypto, vault model, matcher, generator, TOTP, QR, CSV, sync
src/background/          service worker (holds the key, answers every request), sync
src/content/             form detection, autofill, inline menu, save prompt, QR region picker
src/popup/               the toolbar popup
src/options/             full manager: items, settings, import/export, backups, sync
src/onboarding/          first-run master password setup
tests/                   library test suite, QR fixtures, login-form fixtures
tools/make-icons.js      regenerates the PNG icons
tools/serve.js           static server for the test pages
tools/package.js         builds the Chrome Web Store upload
store/                   listing copy and privacy policy for publishing
```

No build step. Edit a file, hit **Reload** on the extensions page.

To publish: `node tools/package.js` writes `dist/keyring-<version>.zip`, and
[store/listing.md](store/listing.md) has every field the Chrome Web Store asks for.

## Tests

```bash
node tests/run.mjs
```

The same suite runs in a browser at `tests/test.html`, and `tests/forms.html` holds
login forms in the shapes the detector has to handle (plain, no `<form>`, decoy
fields, two-step, shadow DOM, late-rendered, one-time code, sign-up, unlabelled,
"Email address", username-not-email, non-English labels, iframe). Serve
them rather than opening from disk:

```bash
node tools/serve.js
```
