/**
 * R146.340 — Continuous Code Review (closes code.review 6→8)
 *
 * Lightweight static review pass over file content. Catches common bugs
 * + smells without needing an LLM call. Designed to run on every patch
 * or on demand via brain-task.
 */

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical'

export interface Finding {
  rule:       string
  severity:   Severity
  line:       number
  message:    string
  suggestion?: string
}

export interface ReviewReport {
  fileHint:   string
  findings:   Finding[]
  counts:     Record<Severity, number>
  passed:     boolean         // no high/critical
  summary:    string
}

interface Rule {
  id:         string
  severity:   Severity
  pattern:    RegExp
  message:    string
  suggestion?: string
  // Optional: a follow-up check to reduce false positives.
  contextOk?: (line: string, allLines: string[], lineIdx: number) => boolean
}

const RULES: Rule[] = [
  // Critical
  { id: 'hardcoded_api_key', severity: 'critical',
    pattern: /(sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{12,}|ghp_[a-zA-Z0-9]{20,})/,
    message: 'Possible hardcoded API key / secret in source',
    suggestion: 'Move to environment variable; rotate the leaked key.' },
  { id: 'console_log_token', severity: 'high',
    pattern: /console\.(log|error)\(.*(token|password|secret|key)/i,
    message: 'Logging may include credential token',
    suggestion: 'Redact via the redactSecrets helper before logging.' },

  // High
  { id: 'sql_string_concat', severity: 'high',
    pattern: /db\.(execute|query)\(['"`][^'"`]*\+/,
    message: 'String-concatenated SQL — risk of SQL injection',
    suggestion: 'Use parameterized queries via drizzle sql`...${var}` template tag.' },
  { id: 'unbounded_loop_potential', severity: 'medium',
    pattern: /while\s*\(\s*true\s*\)/,
    message: 'while(true) loop without obvious break',
    suggestion: 'Add iteration cap + clear exit condition; surface progress to caller.' },
  { id: 'unhandled_promise', severity: 'medium',
    pattern: /^\s*(await\s+)?(fetch|db\.(execute|insert|update|delete))\(/,
    message: 'External call without explicit error handling on this line',
    suggestion: 'Wrap in try/catch; convert to BlockerReport on failure.',
    contextOk: (_line, allLines, idx) => {
      // Tolerate if surrounded by try/catch
      const before = allLines.slice(Math.max(0, idx - 5), idx).join('\n')
      const after  = allLines.slice(idx, idx + 5).join('\n')
      return /\btry\s*\{/.test(before) || /\.catch\(/.test(after) || /\bthen\(/.test(after)
    },
  },

  // Medium / low
  { id: 'todo_marker', severity: 'low',
    pattern: /\bTODO\b|\bFIXME\b|\bXXX\b/,
    message: 'TODO/FIXME marker in source',
    suggestion: 'Convert to task ID + log via brain-task; remove from production code.' },
  { id: 'any_type', severity: 'low',
    pattern: /:\s*any\b/,
    message: 'Explicit `any` type — weakens type safety',
    suggestion: 'Replace with concrete type or `unknown` + narrowing.' },
  { id: 'magic_number_seconds', severity: 'info',
    pattern: /\b(86400|3600|604800)\b/,
    message: 'Magic number for seconds (1 day / 1 hour / 1 week)',
    suggestion: 'Use named constant like ONE_DAY_MS or compute inline (24 * 3600).' },

  // Privacy / policy hooks
  { id: 'submit_form_no_policy_check', severity: 'high',
    pattern: /(formSubmit|enterPersonalInfo|publishField)\(/,
    message: 'Form-submit op should call enforceHardPolicy + checkBeforeSubmit first',
    suggestion: 'Add policy.check_action + privacy.check_submit pre-flight.' },
]

export function reviewSource(fileHint: string, content: string): ReviewReport {
  const lines = content.split(/\r?\n/)
  const findings: Finding[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^\s*(\/\/|\*)/.test(line)) continue  // skip comments
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue
      if (rule.contextOk && rule.contextOk(line, lines, i)) continue
      findings.push({
        rule:       rule.id,
        severity:   rule.severity,
        line:       i + 1,
        message:    rule.message,
        ...(rule.suggestion ? { suggestion: rule.suggestion } : {}),
      })
    }
  }

  const counts: Record<Severity, number> = { info: 0, low: 0, medium: 0, high: 0, critical: 0 }
  for (const f of findings) counts[f.severity]++

  const passed = counts.critical === 0 && counts.high === 0
  const summary = passed
    ? `Review clean. ${findings.length} non-blocking finding(s).`
    : `Review blocked: ${counts.critical} critical, ${counts.high} high. Fix before merge.`

  return { fileHint, findings, counts, passed, summary }
}

/** Review a single file by path on disk. Returns null if unreadable. */
export async function reviewFile(filePath: string): Promise<ReviewReport | null> {
  try {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile(filePath, 'utf8')
    return reviewSource(filePath, content)
  } catch {
    return null
  }
}
