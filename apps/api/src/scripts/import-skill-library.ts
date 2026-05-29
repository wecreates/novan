/**
 * import-skill-library.ts
 *
 * Standalone CLI: imports a directory of SKILL.md files into the
 * skill_library table. Idempotent — re-running is safe and only
 * updates rows whose file hash changed.
 *
 * Run:
 *   pnpm --filter @ops/api exec tsx src/scripts/import-skill-library.ts \
 *     "C:/Users/19496/Downloads/awesome-copilot-main/skills" \
 *     --source-repo awesome-copilot
 *
 * Exit codes:
 *   0 = success
 *   1 = bad args / directory unreadable
 *   2 = ingest completed but with errors per-file
 */
import { ingestSkillsFromDirectory } from '../services/skill-library.js'

async function main() {
  const args = process.argv.slice(2)
  const rootDir = args[0]
  if (!rootDir) {
    // eslint-disable-next-line no-console
    console.error('Usage: import-skill-library.ts <root_dir> [--source-repo <name>]')
    process.exit(1)
  }

  const srcFlagIdx = args.indexOf('--source-repo')
  const sourceRepo = srcFlagIdx >= 0 ? args[srcFlagIdx + 1] : 'awesome-copilot'

  // eslint-disable-next-line no-console
  console.log(`[import-skill-library] scanning ${rootDir} as '${sourceRepo}'…`)
  const result = await ingestSkillsFromDirectory(rootDir, {
    ...(sourceRepo ? { sourceRepo } : {}),
  })
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2))

  if (result.errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`[import-skill-library] ${result.errors.length} per-file errors`)
    process.exit(2)
  }
  process.exit(0)
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[import-skill-library] fatal:', (e as Error).message)
  process.exit(1)
})
