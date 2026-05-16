/**
 * repo-scanner.ts — Real filesystem scanner.
 * Walks the repo, excludes irrelevant dirs, categorises files by type.
 * Never reads file contents — only stat + path analysis.
 */
import { readdir, stat } from 'node:fs/promises'
import { join, extname, relative } from 'node:path'

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.turbo', '.cache',
  'coverage', '.nyc_output', 'logs', '.next', '.nuxt', 'out',
  '__pycache__', '.venv', 'venv', '.tox',
])

const TYPE_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.jsonc': 'json',
  '.md': 'markdown', '.mdx': 'markdown',
  '.sql': 'sql',
  '.css': 'css', '.scss': 'css',
  '.html': 'html',
  '.sh': 'shell', '.bash': 'shell',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.toml': 'toml',
  '.env': 'env',
}

export interface FileEntry {
  path:  string   // relative to rootPath
  size:  number   // bytes
  lines: number   // estimated (size / 40 avg chars per line — we don't read)
  type:  string
}

export interface RepoSnapshot {
  rootPath:   string
  fileCount:  number
  totalLines: number
  fileTree:   FileEntry[]
  summary: {
    byType:      Record<string, number>  // type → count
    byDirectory: Record<string, number>  // top-level dir → count
  }
}

const MAX_FILES = 5_000  // safety cap

async function walk(dir: string, root: string, out: FileEntry[], depth: number): Promise<void> {
  if (depth > 20 || out.length >= MAX_FILES) return
  let entries: string[]
  try { entries = await readdir(dir) } catch { return }
  for (const name of entries) {
    if (out.length >= MAX_FILES) break
    if (EXCLUDE_DIRS.has(name)) continue
    const full = join(dir, name)
    let s: Awaited<ReturnType<typeof stat>>
    try { s = await stat(full) } catch { continue }
    if (s.isDirectory()) {
      await walk(full, root, out, depth + 1)
    } else if (s.isFile()) {
      const ext  = extname(name).toLowerCase()
      const type = TYPE_MAP[ext] ?? 'other'
      out.push({
        path:  relative(root, full).replace(/\\/g, '/'),
        size:  s.size,
        lines: Math.ceil(s.size / 40),
        type,
      })
    }
  }
}

export async function scanRepo(rootPath: string): Promise<RepoSnapshot> {
  const fileTree: FileEntry[] = []
  await walk(rootPath, rootPath, fileTree, 0)

  const byType: Record<string, number> = {}
  const byDirectory: Record<string, number> = {}
  let totalLines = 0

  for (const f of fileTree) {
    byType[f.type] = (byType[f.type] ?? 0) + 1
    const topDir = f.path.split('/')[0] ?? '.'
    byDirectory[topDir] = (byDirectory[topDir] ?? 0) + 1
    totalLines += f.lines
  }

  return { rootPath, fileCount: fileTree.length, totalLines, fileTree, summary: { byType, byDirectory } }
}
