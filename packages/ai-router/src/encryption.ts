/**
 * AES-256-GCM encryption for API keys stored in DB.
 * Requires ENCRYPTION_KEY env var: 64 hex chars (32 bytes).
 * Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGO = 'aes-256-gcm'
const TAG_LEN = 16

function getKey(): Buffer {
  const k = process.env['ENCRYPTION_KEY']
  if (!k) throw new Error('ENCRYPTION_KEY env var is not set')
  const buf = Buffer.from(k, 'hex')
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes)')
  return buf
}

export interface Encrypted {
  ciphertext: string  // hex: encrypted bytes + 16-byte auth tag
  iv:         string  // hex: 12-byte nonce
}

export function encrypt(plaintext: string): Encrypted {
  const iv     = randomBytes(12)
  const cipher = createCipheriv(ALGO, getKey(), iv)
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag    = cipher.getAuthTag()
  return {
    ciphertext: Buffer.concat([enc, tag]).toString('hex'),
    iv:         iv.toString('hex'),
  }
}

export function decrypt(ciphertext: string, iv: string): string {
  const data     = Buffer.from(ciphertext, 'hex')
  const tag      = data.subarray(data.length - TAG_LEN)
  const enc      = data.subarray(0, data.length - TAG_LEN)
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(iv, 'hex'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

/** Returns true if ENCRYPTION_KEY is configured. */
export function encryptionAvailable(): boolean {
  try { getKey(); return true } catch { return false }
}
