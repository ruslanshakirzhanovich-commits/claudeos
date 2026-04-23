import { describe, it, expect } from 'vitest'
import { runAgent } from '../src/agent.js'

describe('runAgent permissionMode gate', () => {
  it('refuses to run without an explicit permissionMode (no silent bypassPermissions)', async () => {
    await expect(
      // Simulate a caller that forgets to pass permissionMode — the type system
      // catches this at compile time, but the runtime guard catches `as any`
      // escapes or JS callers.
      runAgent('hello', {} as never),
    ).rejects.toThrow(/permissionMode is required/)
  })

  it('refuses an explicit falsy permissionMode', async () => {
    await expect(
      runAgent('hello', { permissionMode: undefined as never }),
    ).rejects.toThrow(/permissionMode is required/)
  })
})
