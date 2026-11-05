# Dev Companion Bridge (Chrome extension)

Connects your real Chrome (with your own logins) to the Dev Companion desktop app over `127.0.0.1` only.

## Install
1. Chrome → `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → select this `apps/browser-extension` folder.
3. Desktop app → **Security & activity** → **Browser bridge** → copy the pairing token.
4. Click the extension icon → paste the token → **Save & connect**. Badge shows **ON**.

## What it can do
| Request | What happens | Permission in the app |
|---|---|---|
| Read active tab | URL, title, headings, visible text, form field labels and buttons | Allowed (when bridge enabled) |
| Fill fields | Sets values of fields the AI names | Asks you (Supervised / Autonomous) |
| Click button | Clicks one element | Asks you; payment buttons/pages are always blocked |
| Open URL | Opens a new tab | Asks you |

## What it never does
- Never sends values of password, OTP, card, CVV, API-key/secret/token fields to the app.
- Never fills those fields with AI-written values. Only a secret from your **local vault** can be filled there, and the AI never sees it.
- Never submits payments.
- Web pages cannot talk to the bridge: only `chrome-extension://` origins with the correct token are accepted.
