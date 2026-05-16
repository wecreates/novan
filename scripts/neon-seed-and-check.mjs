import postgres from '../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/index.js'
import crypto from 'node:crypto'

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' })
const now = Date.now()

try {
  // ─── Check workspaces ───────────────────────────────────────────────────────
  let ws = await sql`SELECT id, name, slug FROM workspaces`
  console.log(`Workspaces found: ${ws.length}`)

  if (ws.length === 0) {
    console.log('Seeding default workspace…')
    await sql`
      INSERT INTO workspaces (id, name, slug, plan, owner_id, settings, created_at, updated_at)
      VALUES ('default', 'Default', 'default', 'free', 'owner', '{}'::jsonb, ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `
    ws = await sql`SELECT id, name, slug FROM workspaces`
    console.log(`✓ Workspaces now: ${ws.length}`)
  }

  // ─── Tonight Mode safety flags ──────────────────────────────────────────────
  for (const w of ws) {
    const existing = await sql`SELECT id FROM runtime_safety_flags WHERE id = ${w.id}`
    if (existing.length === 0) {
      await sql`
        INSERT INTO runtime_safety_flags (
          id, workspace_id,
          autonomous_deploy_allowed, self_edit_loops_allowed,
          autonomous_deps_upgrades_allowed, destructive_migrations_allowed,
          internet_learning_swarm_allowed,
          approval_gated_patches_enabled, failure_learning_enabled,
          observability_enabled, war_room_enabled,
          cron_scans_enabled, incident_alerts_enabled,
          tonight_mode_active, set_by, notes, updated_at
        ) VALUES (
          ${w.id}, ${w.id},
          false, false, false, false, false,
          true, true, true, true, true, true,
          true, 'launch-init', 'Initialized at launch', ${now}
        ) ON CONFLICT (id) DO NOTHING
      `
      console.log(`✓ Safety flags initialized for workspace '${w.id}'`)
    } else {
      console.log(`  Safety flags already exist for '${w.id}'`)
    }
  }

  // ─── Security team (10 agents) ──────────────────────────────────────────────
  const TEAM = [
    ['cso',        'Chief Security Officer Agent', 'cso',        'Owns security strategy, reviews critical risks',         ['aggregate', 'escalate', 'approve_posture']],
    ['appsec',     'AppSec Agent',                  'appsec',     'Scans code for unsafe auth, input validation, injection', ['scan_code', 'review_routes', 'block_insecure_patches']],
    ['cloud',      'Cloud Security Agent',          'cloud',      'Reviews Docker, env, deploy, remote worker exposure',     ['review_deploy', 'check_exposure', 'validate_cloud_runtime']],
    ['secrets',    'Secrets Security Agent',        'secrets',    'Audits API key handling, encryption, rotation',           ['audit_secrets', 'verify_encryption', 'enforce_rotation']],
    ['runtime',    'Runtime Threat Detection',      'runtime',    'Detects suspicious workflows, provider abuse',            ['detect_abuse', 'detect_runaway', 'monitor_queues']],
    ['tenant',     'Tenant Isolation Agent',        'tenant',     'Verifies workspace isolation, RBAC, cross-tenant leaks',  ['check_isolation', 'verify_rbac', 'detect_leaks']],
    ['patch',      'Patch Security Reviewer',       'patch',      'Reviews every autonomous patch for security risk',        ['review_patches', 'block_risky_diffs', 'flag_sensitive_changes']],
    ['red',        'Red Team Agent',                'red',        'Safe adversarial probing — findings only',                ['probe_auth', 'probe_permissions', 'create_findings']],
    ['blue',       'Blue Team Agent',               'blue',       'Turns findings into fixes, validates protections',        ['create_mitigations', 'validate_fixes', 'confirm_resolution']],
    ['compliance', 'Compliance Audit Agent',       'compliance', 'Verifies audit logs, retention, admin trails',           ['verify_audit_logs', 'check_retention', 'verify_exports']],
  ]
  for (const [id, name, role, desc, caps] of TEAM) {
    await sql`
      INSERT INTO security_agents (
        id, name, role, description, capabilities,
        is_active, findings_produced, created_at, updated_at
      ) VALUES (
        ${id}, ${name}, ${role}, ${desc}, ${caps},
        true, 0, ${now}, ${now}
      ) ON CONFLICT (id) DO NOTHING
    `
  }
  const agents = await sql`SELECT COUNT(*)::int as c FROM security_agents`
  console.log(`✓ Security team: ${agents[0].c}/10 agents registered`)

  // ─── Default plans ─────────────────────────────────────────────────────────
  const PLANS = [
    ['free',       'Free',       0,    1,   5,    1,   100000,     10],
    ['starter',    'Starter',    49,   5,   25,   3,   1000000,    100],
    ['pro',        'Pro',        199,  25,  100,  10,  10000000,   500],
    ['enterprise', 'Enterprise', 999,  999, 9999, 100, 100000000,  10000],
  ]
  for (const [id, name, price, seat, wf, w_lim, tokens, spend] of PLANS) {
    await sql`
      INSERT INTO plans (
        id, name, monthly_price_usd, seat_limit, workflow_limit,
        workspace_limit, monthly_token_limit, monthly_spend_limit_usd,
        feature_flags, is_active, created_at
      ) VALUES (
        ${id}, ${name}, ${price}, ${seat}, ${wf}, ${w_lim}, ${tokens}, ${spend},
        ${id === 'free' ? '{"autonomousAgents":false,"remoteWorkers":false}' :
          id === 'starter' ? '{"autonomousAgents":true,"remoteWorkers":false}' :
          id === 'pro' ? '{"autonomousAgents":true,"remoteWorkers":true}' :
          '{"autonomousAgents":true,"remoteWorkers":true,"ssoSaml":true,"auditExport":true}'}::jsonb,
        true, ${now}
      ) ON CONFLICT (id) DO NOTHING
    `
  }
  const plans = await sql`SELECT COUNT(*)::int as c FROM plans`
  console.log(`✓ Plans: ${plans[0].c}/4 seeded`)

  // ─── Default subscription for default workspace ────────────────────────────
  for (const w of ws) {
    const sub = await sql`SELECT id FROM subscriptions WHERE workspace_id = ${w.id}`
    if (sub.length === 0) {
      const subId = crypto.randomUUID()
      const trialEnd = now + 14 * 24 * 3600_000
      await sql`
        INSERT INTO subscriptions (
          id, workspace_id, plan_id, status,
          current_period_start, current_period_end, trial_ends_at,
          created_at, updated_at
        ) VALUES (
          ${subId}, ${w.id}, 'starter', 'trialing',
          ${now}, ${now + 30 * 24 * 3600_000}, ${trialEnd},
          ${now}, ${now}
        )
      `
      console.log(`✓ Subscription (starter, 14-day trial) created for '${w.id}'`)
    }
  }

  // ─── Owner permission for default workspace ────────────────────────────────
  for (const w of ws) {
    const perm = await sql`SELECT id FROM permissions WHERE workspace_id = ${w.id} AND user_id = 'owner'`
    if (perm.length === 0) {
      const permId = crypto.randomUUID()
      // Owner gets all permissions
      const ALL_PERMS = [
        'workspace.view','workspace.edit','workspace.delete',
        'members.invite','members.remove','roles.assign',
        'billing.view','billing.manage','plan.change',
        'workflow.run','workflow.pause','agent.control',
        'replay.trigger','rollback.trigger',
        'deploy.trigger','launch.override',
        'patch.approve','patch.dispatch',
        'secret.read_redacted','secret.reveal','secret.rotate','secret.delete',
        'audit.export','audit.view',
      ]
      await sql`
        INSERT INTO permissions (id, user_id, workspace_id, role, grants, granted_by, created_at, updated_at)
        VALUES (${permId}, 'owner', ${w.id}, 'owner', ${ALL_PERMS}, 'system', ${now}, ${now})
      `
      console.log(`✓ Owner permission grant created for '${w.id}'`)
    }
  }

  // ─── Default kill switches (patch #3) ─────────────────────────────────────
  const SWITCHES = ['ai_request', 'remote_worker', 'browser_job', 'provider']
  for (const w of ws) {
    for (const switchType of SWITCHES) {
      const sid = `${w.id}-${switchType}`
      await sql`
        INSERT INTO kill_switches (
          id, workspace_id, switch_type, enabled, created_at, updated_at
        ) VALUES (
          ${sid}, ${w.id}, ${switchType}, false, ${now}, ${now}
        ) ON CONFLICT (id) DO NOTHING
      `.catch((e) => console.log(`  (kill_switches insert skipped: ${e.message.slice(0,80)})`))
    }
  }
  const sw = await sql`SELECT COUNT(*)::int as c FROM kill_switches`
  console.log(`✓ Kill switches: ${sw[0].c} configured`)

  // ─── Owner API token (patch #4) ───────────────────────────────────────────
  for (const w of ws) {
    const existing = await sql`SELECT id, prefix FROM api_tokens WHERE workspace_id = ${w.id} AND name = 'owner-bootstrap'`.catch(() => [])
    if (existing.length === 0) {
      const tokenSecret = crypto.randomBytes(32).toString('hex')
      const tokenPlain  = `ops_${tokenSecret}`
      const tokenHash   = crypto.createHash('sha256').update(tokenPlain).digest('hex')
      const tokenId     = crypto.randomUUID()
      try {
        await sql`
          INSERT INTO api_tokens (
            id, workspace_id, name, token_hash, prefix,
            scopes, created_at
          ) VALUES (
            ${tokenId}, ${w.id}, 'owner-bootstrap',
            ${tokenHash}, ${tokenPlain.slice(0, 8)},
            ${['read', 'write', 'admin']},
            ${now}
          )
        `
        console.log(`\n  ━━━ NEW OWNER TOKEN FOR '${w.id}' (save now, won't be shown again) ━━━`)
        console.log(`  ${tokenPlain}`)
        console.log(`  ━━━ USE: curl -H "Authorization: Bearer ${tokenPlain}" ... ━━━\n`)
      } catch (e) {
        console.log(`  (api_tokens insert failed: ${e.message.slice(0, 100)})`)
      }
    } else {
      console.log(`  Owner token already exists for '${w.id}' (prefix: ${existing[0].prefix})`)
    }
  }

  console.log('\n✓ Neon ready for launch')
} catch (e) {
  console.error('seed error:', e.message)
  process.exit(1)
} finally {
  await sql.end()
}
