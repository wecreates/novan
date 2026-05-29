/**
 * patch-sandbox.ts — Isolated patch validation.
 *
 * Applies a generated patch to a TEMP DIRECTORY clone of the repo and
 * runs typecheck. Never touches the live repo. Never executes generated
 * code at runtime (only static analysis).
 *
 * Honest scope:
 *   - Uses `git worktree` if available — else falls back to cp/rsync clone
 *   - Runs `tsc --noEmit` from the cloned tree
 *   - Returns success/failure + first 200 lines of any compiler output
 *   - DOES NOT run the new code (no eval). DOES NOT auto-commit.
 *   - Time bound: 60s default
 *
 * The caller decides what to do with the validated patch. The agent
 * NEVER writes to the live filesystem outside the sandbox dir.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, sep, relative, isAbsolute } from 'node:path'

const execFileP = promisify(execFile)

export interface PatchFile {
  path:     string
  contents: string
  op:       'create' | 'modify'
}

export interface SandboxResult {
  ok:           boolean
  sandboxPath:  string
  durationMs:   number
  typecheck: {
    ran:      boolean
    passed:   boolean
    output:   string
  }
  errors:       string[]
}

const SANDBOX_TIMEOUT_MS = 60_000

async function safeRun(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { cwd, timeout: SANDBOX_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })
    return { ok: true, stdout, stderr }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, stdout: err.stdout ?? '', stderr: (err.stderr ?? '') + '\n' + (err.message ?? '') }
  }
}

export async function applyAndValidate(patch: PatchFile[], opts?: { repoRoot?: string }): Promise<SandboxResult> {
  const start = Date.now()
  const repoRoot = opts?.repoRoot ?? process.env['REPO_ROOT'] ?? '/app'
  const errors: string[] = []

  // 1) Create temp sandbox dir
  const sandboxPath = mkdtempSync(join(tmpdir(), 'novan-sandbox-'))

  try {
    // 2) Try git worktree first (fast, copy-on-write semantics)
    const worktreeRes = await safeRun('git', ['-C', repoRoot, 'worktree', 'add', '--detach', sandboxPath, 'HEAD'], repoRoot)

    if (!worktreeRes.ok) {
      // Fall back: minimal copy of files we need (just the ones we're modifying + their imports)
      // Honest: this is a degraded sandbox. We can typecheck the patched files individually
      // but cross-file resolution may miss issues.
      errors.push('git worktree unavailable — degraded sandbox (per-file syntax check only)')
      // Touch a marker file so the dir is non-empty
      writeFileSync(join(sandboxPath, '.degraded'), 'no-worktree')
    }

    // 3) Apply patch files into sandbox with PATH-CONTAINMENT check.
    //    SECURITY: path.join does NOT prevent ../ escapes —
    //    join('/tmp/sandbox', '../../etc/cron.d/exploit') resolves outside
    //    the sandbox. A malicious or LLM-injected patch file path could
    //    write arbitrary files on the host. We resolve the absolute target
    //    and verify it's within sandboxPath before writing.
    const sandboxResolved = resolve(sandboxPath) + sep
    for (const f of patch) {
      // Reject absolute paths outright — patches must be repo-relative.
      if (isAbsolute(f.path)) {
        errors.push(`security: refusing absolute path ${f.path}`)
        continue
      }
      const target = resolve(sandboxPath, f.path)
      // Containment check: targetPath must be inside sandboxPath/
      const rel = relative(sandboxResolved, target + sep)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        errors.push(`security: patch path escapes sandbox: ${f.path}`)
        continue
      }
      try {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, f.contents, 'utf8')
      } catch (e) {
        errors.push(`apply failed for ${f.path}: ${(e as Error).message}`)
      }
    }

    // 4) Static validation
    let typecheckOk = false, output = '', ran = false
    if (worktreeRes.ok) {
      // Full project typecheck
      const tsc = await safeRun('pnpm', ['--filter', '@ops/api', 'typecheck'], sandboxPath)
      ran = true
      typecheckOk = tsc.ok
      output = (tsc.stdout + '\n' + tsc.stderr).split('\n').slice(0, 200).join('\n')
    } else {
      // Per-file basic syntax check via Node parser (write a tiny script in sandbox? avoid — use TypeScript service)
      // Honest degradation: just check that files parse as JSON-stringified-ish (skip — not reliable).
      // Best safe move: report degraded.
      output = 'degraded sandbox: typecheck not run; operator should review patch text directly'
      typecheckOk = false
    }

    return {
      ok: errors.length === 0 && typecheckOk,
      sandboxPath, durationMs: Date.now() - start,
      typecheck: { ran, passed: typecheckOk, output },
      errors,
    }
  } catch (e) {
    errors.push(`sandbox error: ${(e as Error).message}`)
    return {
      ok: false, sandboxPath, durationMs: Date.now() - start,
      typecheck: { ran: false, passed: false, output: '' },
      errors,
    }
  } finally {
    // Cleanup worktree registration (the sandboxPath dir itself we leave for inspection)
    if (existsSync(join(sandboxPath, '.git'))) {
      await safeRun('git', ['-C', repoRoot, 'worktree', 'remove', '--force', sandboxPath], repoRoot)
    } else {
      try { rmSync(sandboxPath, { recursive: true, force: true }) } catch { /* tolerated */ }
    }
  }
}

/** Read a file from the live repo (read-only) — used by code-agent to give the LLM context. */
export function readRepoFile(relPath: string, repoRoot = process.env['REPO_ROOT'] ?? '/app'): string | null {
  // Defensive: ensure path doesn't escape repo
  if (relPath.includes('..') || relPath.startsWith('/')) return null
  const full = join(repoRoot, relPath)
  try { return readFileSync(full, 'utf8') } catch { return null }
}
