/**
 * git-state.ts — Tier-4: code-state memory.
 *
 * Reads recent git commits via `git log` and persists snapshots so
 * reasoning chains can later be correlated to "code state at time of
 * decision". Honest about working directory state.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { db } from '../db/client.js'
import { codeStateSnapshots } from '../db/schema.js'
import { desc, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

const execFileP = promisify(execFile)

interface GitCommit {
  sha:        string
  branch:     string
  message:    string
  committedAt: number
  filesChanged: number
}

async function gitLog(repoRoot: string, limit = 20): Promise<GitCommit[]> {
  try {
    const { stdout: branch } = await execFileP('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const { stdout: log } = await execFileP('git', [
      '-C', repoRoot, 'log',
      `-${limit}`,
      '--pretty=format:%H%x09%ct%x09%s',
    ])
    const lines = log.trim().split('\n').filter(Boolean)
    const commits: GitCommit[] = []
    for (const line of lines) {
      const [sha, ts, ...msgParts] = line.split('\t')
      if (!sha || !ts) continue
      const { stdout: numstat } = await execFileP('git', ['-C', repoRoot, 'show', '--numstat', '--format=', sha]).catch(() => ({ stdout: '' }))
      const filesChanged = numstat.trim().split('\n').filter(Boolean).length
      commits.push({
        sha,
        branch: branch.trim(),
        message: msgParts.join('\t'),
        committedAt: Number(ts) * 1000,
        filesChanged,
      })
    }
    return commits
  } catch (e) {
    return []
  }
}

export async function captureGitState(workspaceId: string, repoRoot = process.env['REPO_ROOT'] ?? '/app'): Promise<{ captured: number; available: boolean }> {
  const commits = await gitLog(repoRoot, 20)
  if (commits.length === 0) return { captured: 0, available: false }
  let captured = 0
  for (const c of commits) {
    await db.insert(codeStateSnapshots).values({
      id: uuidv7(),
      workspaceId,
      gitSha: c.sha,
      branch: c.branch,
      commitMessage: c.message.slice(0, 500),
      filesChanged: c.filesChanged,
      committedAt: c.committedAt,
      capturedAt:  Date.now(),
    }).onConflictDoNothing().then(() => captured++).catch((e: Error) => { console.error('[git-state]', e.message); return null })
  }
  return { captured, available: true }
}

export async function recentSnapshots(workspaceId: string, limit = 30) {
  return db.select().from(codeStateSnapshots)
    .where(eq(codeStateSnapshots.workspaceId, workspaceId))
    .orderBy(desc(codeStateSnapshots.committedAt))
    .limit(limit).catch(() => [])
}

/**
 * Find the code state that was active when an event happened.
 * Returns the snapshot whose committedAt <= timestamp.
 */
export async function snapshotAt(workspaceId: string, timestamp: number) {
  const rows = await db.select().from(codeStateSnapshots)
    .where(eq(codeStateSnapshots.workspaceId, workspaceId))
    .orderBy(desc(codeStateSnapshots.committedAt))
    .catch(() => [])
  return rows.find(r => r.committedAt <= timestamp) ?? null
}
