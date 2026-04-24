import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys'
import type { AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys'
import { WHATSAPP_AUTH_ENCRYPTION_KEY } from '../config.js'

const IV_LEN = 12
const TAG_LEN = 16
const ALGO = 'aes-256-gcm'

export function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new Error(`encrypt: key must be 32 bytes, got ${key.length}`)
  }
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct])
}

export function decrypt(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new Error(`decrypt: key must be 32 bytes, got ${key.length}`)
  }
  if (ciphertext.length < IV_LEN + TAG_LEN) {
    throw new Error('auth file decryption failed: payload too short')
  }
  const iv = ciphertext.subarray(0, IV_LEN)
  const tag = ciphertext.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const body = ciphertext.subarray(IV_LEN + TAG_LEN)
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new Error('auth file decryption failed')
  }
}

const ENCRYPTED_EXT = '.json.enc'
const SAFE_NAME_RE = /^[A-Za-z0-9._@-]+$/

// Mirrors baileys's fixFileName: it sanitizes ids containing `/` or `:` to
// underscore/dash before they hit disk. We run the same mapping so legacy
// migrated files land on the same names.
function fixFileName(name: string): string {
  return name.replace(/\//g, '__').replace(/:/g, '-')
}

function assertSafeFileBase(name: string): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`invalid auth key id: ${name.slice(0, 100)}`)
  }
}

function encFilePath(folder: string, name: string): string {
  // `..` must be rejected on the raw name: fixFileName() rewrites `/` to `__`
  // so a post-fix path.resolve() check would no longer catch a traversal attempt
  // like `../../evil` — the slashes are gone by then.
  if (name.includes('..')) {
    throw new Error(`invalid auth key id: ${name.slice(0, 100)}`)
  }
  const fixed = fixFileName(name)
  assertSafeFileBase(fixed)
  return path.join(folder, `${fixed}${ENCRYPTED_EXT}`)
}

async function writeEncrypted(
  folder: string,
  name: string,
  data: unknown,
  key: Buffer,
): Promise<void> {
  const json = JSON.stringify(data, BufferJSON.replacer)
  const ct = encrypt(Buffer.from(json, 'utf8'), key)
  const target = encFilePath(folder, name)
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  await fs.promises.writeFile(tmp, ct)
  await fs.promises.rename(tmp, target)
}

async function readEncrypted(
  folder: string,
  name: string,
  key: Buffer,
): Promise<unknown | null> {
  const target = encFilePath(folder, name)
  let raw: Buffer
  try {
    raw = await fs.promises.readFile(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const pt = decrypt(raw, key)
  return JSON.parse(pt.toString('utf8'), BufferJSON.reviver)
}

async function removeEncrypted(folder: string, name: string): Promise<void> {
  try {
    await fs.promises.unlink(encFilePath(folder, name))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
}

export async function useEncryptedMultiFileAuthState(
  folder: string,
  key: Buffer,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  await fs.promises.mkdir(folder, { recursive: true })

  const creds = ((await readEncrypted(folder, 'creds', key)) as any) || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out: { [id: string]: SignalDataTypeMap[typeof type] } = {}
          await Promise.all(
            ids.map(async (id) => {
              const raw = (await readEncrypted(folder, `${type}-${id}`, key)) as any
              if (raw === null) return // leave out[id] undefined for missing
              const value =
                type === 'app-state-sync-key' && raw
                  ? proto.Message.AppStateSyncKeyData.fromObject(raw)
                  : raw
              out[id] = value
            }),
          )
          return out
        },
        set: async (data) => {
          const tasks: Promise<void>[] = []
          for (const category in data) {
            const bucket = (data as any)[category] as Record<string, unknown>
            for (const id in bucket) {
              const value = bucket[id]
              const file = `${category}-${id}`
              if (value) {
                tasks.push(writeEncrypted(folder, file, value, key))
              } else {
                tasks.push(removeEncrypted(folder, file))
              }
            }
          }
          await Promise.all(tasks)
        },
      },
    },
    saveCreds: async () => writeEncrypted(folder, 'creds', creds, key),
  }
}

export function loadEncryptionKey(): Buffer {
  if (!WHATSAPP_AUTH_ENCRYPTION_KEY) {
    throw new Error(
      'WHATSAPP_AUTH_ENCRYPTION_KEY is required to start the Baileys provider. ' +
        'Generate one with: openssl rand -base64 32',
    )
  }
  const buf = Buffer.from(WHATSAPP_AUTH_ENCRYPTION_KEY, 'base64')
  if (buf.length !== 32) {
    throw new Error(
      `WHATSAPP_AUTH_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length}). ` +
        'Generate one with: openssl rand -base64 32',
    )
  }
  return buf
}
