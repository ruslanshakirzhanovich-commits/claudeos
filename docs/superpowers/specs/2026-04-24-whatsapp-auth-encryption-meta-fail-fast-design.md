# WhatsApp auth encryption and Meta webhook fail-fast

**Date:** 2026-04-24
**Status:** Approved

## Problem

Two concrete security defects in the WhatsApp integration layer:

1. **Baileys session credentials are plain-text on disk.** `useMultiFileAuthState(AUTH_DIR)` writes `creds.json` and `pre-key-*.json` files into `store/whatsapp-auth/` with no encryption. The files contain Noise protocol keys, Signal pre-keys, and session identifiers. Anyone with read access to that directory (a user on the host, a bind-mounted container, a backup that leaked, a cold-boot forensic image) can drop those files into a fresh Baileys install and assume the WhatsApp session. No 2FA, no device re-auth.

2. **`verifySignature` in Meta webhook is fail-open.** [src/whatsapp/meta.ts:44-49](src/whatsapp/meta.ts#L44-L49) returns `true` when `WHATSAPP_META_APP_SECRET` is empty, after a `warn` log. That means an operator who deploys Meta-provider without setting the secret will accept **any** POST from **any** caller as a legitimate webhook, with no signature checked. A malicious actor who guesses the bot's webhook URL can inject arbitrary inbound messages, triggering agent runs under the owning chat's identity.

A third, related loose end:

3. **QR-code PNG lingers on disk after failure paths.** [src/whatsapp/baileys.ts:52-68](src/whatsapp/baileys.ts#L52-L68) writes `store/whatsapp-qr.png` when Baileys requests a pairing code, but only deletes it on `connection === 'open'`. If pairing fails, the process is killed, or `loggedOut` fires, the PNG stays on disk. A stale QR that is still valid (Meta retires them after a short window, but the window is not zero) is a scannable credential.

## Goals

- All Baileys auth files encrypted at rest with AES-256-GCM. Key comes from a new env var.
- First boot after upgrade auto-migrates existing plain files to encrypted form without requiring a QR re-scan.
- `verifySignature` never returns true for an unsigned or unsignable webhook. Meta provider refuses to start without `WHATSAPP_META_APP_SECRET`.
- QR PNG removed on every shutdown path, not just the happy path.

## Non-goals

- Encrypting the SQLite DB, backups, logs, or anything else under `store/`. Different threat model, different key, separate project.
- Key rotation. If this key leaks, the mitigation is "generate a new key, re-scan QR" — documented as the failure mode, not a feature.
- `WHATSAPP_META_ALLOW_UNSIGNED=1` escape hatch for local development. YAGNI; if someone needs a local Meta webhook, they use a sandbox APP_SECRET.
- OS-level protection (SELinux labels, AppArmor profiles, LUKS on `store/`). Out of scope for an app-layer change.
- Changes to the Baileys reconnection strategy, exponential backoff, or any other baileys.ts behavior unrelated to auth encryption and QR cleanup.

## Design

### New module: `src/whatsapp/auth-encryption.ts`

Two exports.

**`useEncryptedMultiFileAuthState(folder: string, key: Buffer): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>`**

A full implementation of Baileys's `AuthenticationState` contract, not a wrapper around the existing `useMultiFileAuthState`. Rationale: the stock helper reads and writes via Node's `fs` directly, so we cannot inject encryption without forking its loop. A parallel implementation is ~80 lines.

Behavior:

- `state.creds`: loaded from `creds.json.enc` on entry. If the file is missing, call `initAuthCreds()` from `@whiskeysockets/baileys` to mint a fresh set. `saveCreds()` serializes `state.creds` via `BufferJSON.replacer`, encrypts, writes atomically (temp file + rename).
- `state.keys`: a `SignalKeyStore` object with `get(type, ids)` and `set(data)` methods. Each key is one file `{type}-{id}.json.enc` (e.g. `pre-key-12.json.enc`, `session-15551234567.0@s.whatsapp.net.json.enc`). `get` decrypts and parses via `BufferJSON.reviver`. `set` writes atomically per key, or deletes the file if the key's new value is `null` or `undefined` (Baileys signals key removal this way).
- Filename sanitization: both `type` and `id` must match `^[A-Za-z0-9._@-]+$` (covers real Baileys key ids like `pre-key-12`, `session-15551234567.0@s.whatsapp.net`, `sender-key-<jid>--<jid>`). Anything else → throw `invalid auth key id`. Defence in depth: Baileys controls the IDs today, but a future regression or a downgrade that swaps the backing library should not silently produce path-traversal writes.

**`migratePlainAuthFiles(folder: string, key: Buffer): Promise<{ migrated: number; alreadyEncrypted: number }>`**

- Ensure `folder` exists (mkdir recursive).
- Read directory entries.
- For every `*.json` file that does NOT also have a sibling `*.json.enc`:
  - Read plain bytes.
  - Encrypt with `key`.
  - Write `*.json.enc` atomically.
  - `fs.unlinkSync` the plain file only after the encrypted write succeeded.
- Return counts. Idempotent: second run with no plain files returns `{ migrated: 0, alreadyEncrypted: N }`.

If a plain file and its encrypted sibling both exist (partial prior migration), prefer the encrypted one and delete the plain — it was likely an interrupted migration that completed the write but never unlinked. Log a warn.

### Encryption format

Single raw binary layout per file:

```
[12 bytes: IV]  [16 bytes: GCM auth tag]  [N bytes: ciphertext]
```

- IV: `crypto.randomBytes(12)` per write. Never reused with the same key (GCM nonce-reuse is catastrophic; 96-bit random is fine at this volume).
- Algorithm: `aes-256-gcm` via `crypto.createCipheriv`.
- No version byte, no header. If the format ever changes, the key would also change (or the decision is made during a planned re-sync), so backward compat is not required.

Helpers inside `auth-encryption.ts`:

```typescript
function encrypt(plaintext: Buffer, key: Buffer): Buffer
function decrypt(ciphertext: Buffer, key: Buffer): Buffer  // throws on tamper or wrong key
```

`decrypt` wraps the `crypto.createDecipheriv` + `decipher.final()` pair in a try/catch that re-throws with a stable error message (`auth file decryption failed`) so callers can differentiate corruption from other I/O errors.

### Config

In `src/config.ts`:

```typescript
export const WHATSAPP_AUTH_ENCRYPTION_KEY = (env['WHATSAPP_AUTH_ENCRYPTION_KEY'] ?? '').trim()
```

No parsing or validation here — the raw string stays in config. Validation lives in a helper inside `auth-encryption.ts`:

```typescript
export function loadEncryptionKey(): Buffer {
  if (!WHATSAPP_AUTH_ENCRYPTION_KEY) {
    throw new Error(
      'WHATSAPP_AUTH_ENCRYPTION_KEY is required to start the Baileys provider. ' +
        'Generate one with: openssl rand -base64 32'
    )
  }
  const buf = Buffer.from(WHATSAPP_AUTH_ENCRYPTION_KEY, 'base64')
  if (buf.length !== 32) {
    throw new Error(
      `WHATSAPP_AUTH_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length}). ` +
        'Generate one with: openssl rand -base64 32'
    )
  }
  return buf
}
```

Keeps config.ts free of security logic and keeps the error text next to the code that needs it.

### Baileys integration

In `src/whatsapp/baileys.ts` `connect()`, replace:

```typescript
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true })
const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
```

with:

```typescript
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true })
const key = loadEncryptionKey()
const migrateResult = await migratePlainAuthFiles(AUTH_DIR, key)
if (migrateResult.migrated > 0) {
  logger.info(migrateResult, 'baileys: encrypted legacy plain auth files')
}
const { state, saveCreds } = await useEncryptedMultiFileAuthState(AUTH_DIR, key)
```

Remove the `useMultiFileAuthState` import from baileys.ts. It is no longer used.

### QR cleanup

Extract a local helper in `src/whatsapp/baileys.ts`:

```typescript
function cleanupQr(): void {
  try {
    if (fs.existsSync(QR_PATH)) fs.unlinkSync(QR_PATH)
  } catch (err) {
    logger.warn({ err }, 'baileys: failed to cleanup QR file')
  }
}
```

Call sites:

- `connection === 'open'` — replaces the existing inline try/catch.
- `connection === 'close'` when `loggedOut === true` — before the `return`.
- `stop()` — before setting `sock = null`.

Not called on every non-logged-out `'close'` because those are transient (reconnect in 3s) and the QR is still valid for that session.

### Meta webhook fail-fast

In `src/whatsapp/meta.ts`:

**Change `verifySignature`:**

```typescript
function verifySignature(body: Buffer, signatureHeader: string | undefined): boolean {
  if (!WHATSAPP_META_APP_SECRET) return false
  if (!signatureHeader) return false
  const expected =
    'sha256=' + crypto.createHmac('sha256', WHATSAPP_META_APP_SECRET).update(body).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected))
  } catch {
    return false
  }
}
```

The warn-and-return-true branch is gone. If `verifySignature` is reachable without `APP_SECRET`, it now rejects.

**Change `start()`:** add the check as the very first statement, before the VERIFY_TOKEN check:

```typescript
async start() {
  if (!WHATSAPP_META_APP_SECRET) {
    throw new Error(
      'meta provider: WHATSAPP_META_APP_SECRET is required — webhook signature verification cannot be disabled'
    )
  }
  if (!WHATSAPP_META_VERIFY_TOKEN) {
    throw new Error('meta provider: WHATSAPP_META_VERIFY_TOKEN is required')
  }
  // ... rest unchanged
}
```

The two errors are thrown, not logged-and-returned, so the existing `initWhatsApp().catch(err => logger.error(...))` in `index.ts:158` surfaces them without silently degrading to "Meta started but broken."

## Observability

- `baileys: encrypted legacy plain auth files` — info, emitted once per boot when migration did work.
- `auth file decryption failed` — thrown by `decrypt`, caught wherever it is called, logged as error.
- Meta fail-fast errors — thrown from `start()`, caught and logged by the caller at init time.

No new metric events. These are startup conditions, not ongoing runtime signals worth counting.

## Testing

New test files under `tests/`:

1. **`whatsapp-auth-encryption.test.ts`**
   - Roundtrip: encrypt a known plaintext, decrypt, assert equal.
   - Tampered ciphertext: flip one bit in the ciphertext body, assert decrypt throws.
   - Wrong key: encrypt with `k1`, decrypt with `k2`, assert throws.
   - BufferJSON roundtrip: encrypt a JSON blob containing `{ x: Buffer.from([1,2,3]) }` via replacer, decrypt and reviver, assert buffer equality.

2. **`whatsapp-auth-migration.test.ts`**
   - Fresh directory with `creds.json` + three `pre-key-*.json` plain files → `migratePlainAuthFiles` produces matching `.enc` files, originals gone, returns `{ migrated: 4, alreadyEncrypted: 0 }`.
   - Run twice on the same directory → second call returns `{ migrated: 0, alreadyEncrypted: 4 }`, no files touched.
   - Directory with one plain + one encrypted sibling (partial prior migration) → plain is deleted, encrypted kept, warn logged.
   - Empty directory → `{ migrated: 0, alreadyEncrypted: 0 }`, no error.

3. **`whatsapp-auth-state.test.ts`**
   - `useEncryptedMultiFileAuthState` on empty directory: `state.creds` comes from `initAuthCreds()`, `saveCreds()` writes `creds.json.enc`, re-opening loads the same creds back.
   - `state.keys.set({ 'pre-key': { '1': somePreKey } })` writes `pre-key-1.json.enc`; a following `state.keys.get('pre-key', ['1'])` returns the original value (Buffer fields intact).
   - `state.keys.set({ 'pre-key': { '1': null } })` deletes the file.
   - Path traversal attempt: constructing a fake `SignalKeyStore` consumer that passes an id containing `..` — assert the store rejects or sanitizes (depending on implementation choice; pick rejection with a clear error).

4. **`whatsapp-meta-fail-fast.test.ts`**
   - `createMetaClient().start()` with `WHATSAPP_META_APP_SECRET = ''` throws the specific error.
   - `verifySignature(body, 'sha256=...')` with empty `APP_SECRET` returns false (covers the removed fail-open branch).
   - Happy path: correct signature with matching secret returns true (regression guard for the timing-safe branch).

5. **`whatsapp-qr-cleanup.test.ts`**
   - Stub the `fs` QR path via a tmp directory. After `stop()` the QR file is gone.
   - Simulate `loggedOut` disconnect (constructed event object) → QR file is gone.
   - Transient close (non-loggedOut) → QR file stays.

All tests use the existing `vitest` conventions in the project: top-level `vi.mock` calls, `await import` for module under test, `beforeEach` for state reset, `afterAll` for cleanup of tmp dirs.

## Rollout

Single PR, single deploy. Operator steps on prod:

1. `openssl rand -base64 32` → copy the output.
2. Append to prod `.env`: `WHATSAPP_AUTH_ENCRYPTION_KEY=<paste>`.
3. Restart the service (`systemctl restart claudeclaw` or `/update` command in bot).

On first start after the upgrade:

- `loadEncryptionKey()` validates the env var.
- `migratePlainAuthFiles` encrypts `creds.json` + any `pre-key-*.json` / `session-*.json` / etc., removes the plain files.
- Baileys opens the session from encrypted state — no QR re-scan needed.

If the env var is missing or malformed, Baileys refuses to start and logs the actionable error. Telegram keeps working, Discord keeps working. The operator sees the failure in logs and fixes the env.

If the env var gets rotated out of band (someone changes the value), encrypted files become undecryptable and Baileys throws `auth file decryption failed`. Documented recovery: delete `store/whatsapp-auth/`, restart, re-scan QR.

The Meta fail-fast change only affects operators running `WHATSAPP_PROVIDER=meta`. For operators on Baileys (default) the change is invisible.

## Risks

- **Baileys internals change.** The adapter implements `AuthenticationState` directly. If Baileys adds a new required field or changes `SignalKeyStore` semantics in a future release, the adapter breaks. Mitigation: the dependency is pinned at `@whiskeysockets/baileys 7.0.0-rc.9`. Future upgrades require a manual review of this module.
- **Atomic write on crash.** Writes go temp → rename. If the process crashes between temp-write and rename, the old encrypted file is still valid. If the crash is between rename and the subsequent `unlink` of the plain version (during migration), partial-migration logic on next boot handles it.
- **Key re-used across hosts.** If `.env` is copied between dev and prod, both hosts can decrypt each other's auth files. This is a deployment convention choice, not a code-level risk. Documented in the design but not enforced.
- **QR race condition.** `cleanupQr` in `stop()` runs before `sock = null`, so a concurrent Baileys event that writes the QR could re-create the file between cleanup and shutdown. The window is sub-millisecond and the on-disk file is no longer load-bearing once the process exits. Acceptable.
