/**
 * pipeline-adapters.ts — Product-type-specific pipeline variants.
 *
 * Mobile / AI / Firmware share the conceptual phases but have radically
 * different mechanics. This module declares the adapters that the
 * coding-topology, release-agent, and SRE-agent consult before
 * choosing a strategy.
 *
 * Each adapter exposes:
 *   - required preMergeChecks (in addition to the universal ones)
 *   - device/eval/HIL matrix to run before promoting to production
 *   - rollout shape that fits the platform's constraints
 *   - rejection/regression-handling protocol specific to the platform
 *   - the agents the topology should spin up
 *
 * Honest scope: this file is the CONFIGURATION layer. Actual execution
 * (uploading to App Store Connect, running HIL rigs, calling eval
 * harnesses) is per-platform tooling that lives in its own future
 * connector modules. The brain holds the playbook here.
 */

export type ProductPipelineType =
  | 'web'                // browser app — Novan's existing default
  | 'mobile_ios'
  | 'mobile_android'
  | 'mobile_rn'          // React Native cross-platform with OTA via Expo/CodePush
  | 'ai_product'         // LLM/RAG/agent product where evals replace unit tests
  | 'embedded_firmware'
  | 'browser_extension'
  | 'desktop'
  | 'api_sdk'

export interface PreMergeRequirement {
  id:           string
  label:        string
  required:     boolean
  notes?:       string
}

export interface RolloutStage {
  name:               string
  trafficPct:         number       // % of users
  minHours:           number       // soak time before promoting
  rollbackCriteria:   string[]
  observabilitySLOs:  string[]
}

export interface PipelineAdapter {
  type:                ProductPipelineType
  description:         string
  preMergeChecks:      PreMergeRequirement[]
  /** Matrix the platform requires to validate a release. */
  validationMatrix:    { axis: string; values: string[]; rationale: string }[]
  /** Default rollout. Operator can override via release policy. */
  rolloutStages:       RolloutStage[]
  /** Agents the topology adds to its specialist roster for this type. */
  specialistAgents:    string[]
  /** Critical risks operator MUST hear about before approving. */
  criticalRisks:       string[]
}

const MOBILE_IOS: PipelineAdapter = {
  type: 'mobile_ios',
  description: 'iOS native app shipped via App Store. Apple is the gatekeeper.',
  preMergeChecks: [
    { id: 'xcode_build',       label: 'Xcode build clean on macOS runner',                  required: true,  notes: 'requires macOS build runner — real cost' },
    { id: 'tests_simulator',   label: 'XCTest suite passes on iOS simulator',               required: true  },
    { id: 'device_matrix',     label: 'E2E smoke on real device cloud (Firebase Test Lab)', required: true,  notes: 'min: iPhone 13/15/16 + iPad' },
    { id: 'memory_pressure',   label: 'No leaks; memory under 200MB at steady state',       required: true  },
    { id: 'launch_time',       label: 'Cold launch < 2s on min-spec device',                required: true  },
    { id: 'crash_free_rate',   label: 'Crash-free session rate > 99.5% in TestFlight',      required: true  },
    { id: 'dsym_uploaded',     label: 'dSYM uploaded to Sentry/Crashlytics for symbolication', required: true },
    { id: 'privacy_labels',    label: 'App Store privacy nutrition labels current',         required: true  },
    { id: 'export_compliance', label: 'Crypto export compliance answered',                  required: true  },
    { id: 'screenshots',       label: 'Localised screenshots generated per device size',    required: true,  notes: 'multi-language matrix' },
  ],
  validationMatrix: [
    { axis: 'OS version',  values: ['iOS 17', 'iOS 18', 'latest beta'], rationale: 'Apple supports the last 2 majors + beta' },
    { axis: 'Device',      values: ['iPhone SE', 'iPhone 15', 'iPhone 16 Pro Max', 'iPad'], rationale: 'screen-size + perf range' },
    { axis: 'Network',     values: ['LTE', 'WiFi', 'offline'],          rationale: 'mobile must degrade gracefully' },
    { axis: 'Locale',      values: ['en-US', 'es-ES', 'ja-JP', 'ar-EG'], rationale: 'RTL + text expansion check' },
  ],
  rolloutStages: [
    { name: 'TestFlight internal',  trafficPct: 0,   minHours: 24, rollbackCriteria: ['any crash on launch', 'any showstopper bug'], observabilitySLOs: ['crash_free > 99.5%'] },
    { name: 'TestFlight external',  trafficPct: 0,   minHours: 72, rollbackCriteria: ['crash_free < 99%', '> 3 unique critical bugs'], observabilitySLOs: ['crash_free > 99.5%', 'app review feedback triaged daily'] },
    { name: 'App Store phased 1%',  trafficPct: 1,   minHours: 24, rollbackCriteria: ['crash_free < 99.5%'], observabilitySLOs: ['crash_free > 99.5%', 'p95 launch < 2s'] },
    { name: 'App Store phased 10%', trafficPct: 10,  minHours: 24, rollbackCriteria: ['crash_free < 99.5%', 'star rating drop > 0.3'], observabilitySLOs: ['crash_free > 99.5%'] },
    { name: 'App Store phased 50%', trafficPct: 50,  minHours: 48, rollbackCriteria: ['any of the above'], observabilitySLOs: ['crash_free > 99.5%'] },
    { name: 'Full release',         trafficPct: 100, minHours: 0,  rollbackCriteria: [],                          observabilitySLOs: [] },
  ],
  specialistAgents: ['ios_build_agent', 'store_submission_agent', 'crash_triage_agent', 'device_matrix_test_agent', 'ota_update_agent'],
  criticalRisks: [
    'losing Apple Developer cert / provisioning profile / App Store Connect key is catastrophic — vaulted storage + rotation procedure mandatory',
    'Apple rejection rate ~30-40% — rejection handling agent must interpret Apple feedback and either fix or appeal',
    'Apple review can take 24h-7d; cannot hotfix without Expedited Review request',
    'Updates are NOT instant — users on older versions persist; backwards-compat protocol design is mandatory',
  ],
}

const MOBILE_ANDROID: PipelineAdapter = {
  ...MOBILE_IOS,
  type: 'mobile_android',
  description: 'Android native app shipped via Google Play. Google Play is the gatekeeper with somewhat faster reviews than Apple.',
  preMergeChecks: [
    { id: 'gradle_build',          label: 'Gradle build clean',                                  required: true  },
    { id: 'tests_emulator',        label: 'Espresso suite passes on Android emulator',           required: true  },
    { id: 'device_matrix',         label: 'E2E smoke on real device cloud (Firebase Test Lab)',  required: true,  notes: 'min: Pixel + Samsung + low-end' },
    { id: 'memory_pressure',       label: 'No leaks; memory under 250MB',                        required: true  },
    { id: 'launch_time',           label: 'Cold launch < 3s on min-spec device',                 required: true  },
    { id: 'crash_free_rate',       label: 'Crash-free session rate > 99% in Internal Testing',   required: true  },
    { id: 'proguard_uploaded',     label: 'ProGuard mappings uploaded for symbolication',        required: true  },
    { id: 'data_safety',           label: 'Google Play data safety form current',                required: true  },
    { id: 'target_sdk',            label: 'targetSdk matches Play current requirement',          required: true  },
    { id: 'app_bundle_signed',     label: 'AAB signed with Play App Signing',                    required: true  },
  ],
  rolloutStages: [
    { name: 'Internal Testing',    trafficPct: 0,   minHours: 24, rollbackCriteria: ['any crash on launch'], observabilitySLOs: ['crash_free > 99%'] },
    { name: 'Closed Beta',         trafficPct: 0,   minHours: 72, rollbackCriteria: ['crash_free < 99%'], observabilitySLOs: ['crash_free > 99%'] },
    { name: 'Open Beta',           trafficPct: 0,   minHours: 168, rollbackCriteria: ['crash_free < 99%'], observabilitySLOs: ['crash_free > 99%'] },
    { name: 'Production 1%',       trafficPct: 1,   minHours: 24, rollbackCriteria: ['crash_free < 99%'], observabilitySLOs: ['crash_free > 99%'] },
    { name: 'Production 20%',      trafficPct: 20,  minHours: 24, rollbackCriteria: ['crash_free < 99%', 'star rating drop > 0.3'], observabilitySLOs: [] },
    { name: 'Production 100%',     trafficPct: 100, minHours: 0,  rollbackCriteria: [],                       observabilitySLOs: [] },
  ],
  specialistAgents: ['android_build_agent', 'store_submission_agent', 'crash_triage_agent', 'device_matrix_test_agent', 'ota_update_agent'],
}

const MOBILE_RN: PipelineAdapter = {
  ...MOBILE_IOS,
  type: 'mobile_rn',
  description: 'React Native / Expo cross-platform. JS layer can ship via Expo Updates / CodePush without store review; native changes still go through stores.',
  preMergeChecks: [
    ...MOBILE_IOS.preMergeChecks,
    { id: 'js_ota_safe',     label: 'Change is JS-only (eligible for OTA)',         required: false, notes: 'native changes require store submission' },
    { id: 'expo_channel',    label: 'Expo Updates channel selected (preview/prod)', required: true  },
  ],
  specialistAgents: [...MOBILE_IOS.specialistAgents, 'ota_update_agent'],
}

const AI_PRODUCT: PipelineAdapter = {
  type: 'ai_product',
  description: 'LLM/RAG/agent product. Evals replace unit tests — quality is graded, not boolean.',
  preMergeChecks: [
    { id: 'eval_set_passes',         label: 'Eval set score did not regress',                        required: true,  notes: 'every prompt / model / retrieval change re-runs evals' },
    { id: 'safety_red_team',         label: 'Safety red-team eval (jailbreak / prompt-injection)',   required: true  },
    { id: 'hallucination_threshold', label: 'Hallucination rate < 5% on ground-truth subset',        required: true  },
    { id: 'cost_per_request',        label: 'Cost-per-request not > 1.2× baseline',                  required: true,  notes: 'AI cost is first-class — model-tier routing mandatory' },
    { id: 'latency_p95',             label: 'p95 latency not > 1.5× baseline',                       required: true  },
    { id: 'pii_filter',              label: 'PII detector clean on synthetic test corpus',           required: true  },
    { id: 'refusal_calibration',     label: 'Refusal rate within ±10% of baseline',                  required: true,  notes: 'too restrictive AND too permissive both fail' },
    { id: 'rag_recall',              label: 'RAG recall@k did not regress',                          required: false, notes: 'only if RAG-backed' },
    { id: 'tool_selection_accuracy', label: 'Agent tool-selection accuracy did not regress',        required: false, notes: 'only if agent-backed' },
  ],
  validationMatrix: [
    { axis: 'Eval set',        values: ['core', 'edge-cases', 'red-team', 'multilingual'], rationale: 'no single set covers all behaviour' },
    { axis: 'Model tier',      values: ['frontier', 'mid', 'small'], rationale: 'each tier must pass its slice; small failing is OK if fallback works' },
    { axis: 'Prompt version',  values: ['production', 'candidate'], rationale: 'A/B production vs candidate' },
  ],
  rolloutStages: [
    { name: 'Shadow',         trafficPct: 0,   minHours: 24, rollbackCriteria: ['eval regression > 2pp'],                              observabilitySLOs: ['eval scores match offline'] },
    { name: 'Canary 1%',      trafficPct: 1,   minHours: 12, rollbackCriteria: ['user thumbs-down > 2× baseline', 'cost > 1.3×'],     observabilitySLOs: ['hallucination rate', 'thumbs-down rate', 'cost per request'] },
    { name: 'Canary 10%',     trafficPct: 10,  minHours: 24, rollbackCriteria: ['regeneration rate > 1.5×'],                          observabilitySLOs: ['retention by cohort'] },
    { name: 'Half',           trafficPct: 50,  minHours: 24, rollbackCriteria: ['any of the above'],                                  observabilitySLOs: [] },
    { name: 'Full',           trafficPct: 100, minHours: 0,  rollbackCriteria: [],                                                    observabilitySLOs: [] },
  ],
  specialistAgents: ['eval_curator', 'prompt_ab_tester', 'retrieval_quality_monitor', 'hallucination_detector', 'cost_optimizer', 'safety_red_team_agent'],
  criticalRisks: [
    'AI quality degrades SILENTLY as models or upstream data drift — without continuous evals you wouldn\'t know',
    'Prompt-injection / jailbreaks are an open category — red-team eval is a baseline, not a guarantee',
    'Cost scales with usage non-linearly — runaway loops are the #1 incident category',
    'Long-horizon agent reliability is the dominant unsolved problem; > 5 step chains compound errors',
    'Model deprecations from providers force forced migrations on the provider\'s timeline, not yours',
  ],
}

const EMBEDDED: PipelineAdapter = {
  type: 'embedded_firmware',
  description: 'Firmware on constrained devices. Updates are risky, sometimes irreversible. Long product lifecycles.',
  preMergeChecks: [
    { id: 'cross_compile_clean',     label: 'Cross-compile passes for target architecture',         required: true  },
    { id: 'reproducible_build',      label: 'Build is byte-identical to a prior build of same SHA', required: true,  notes: 'forensics requirement' },
    { id: 'static_analysis',         label: 'MISRA-C / cppcheck / Coverity clean',                  required: true  },
    { id: 'stack_heap_analysis',     label: 'Stack + heap usage within budget for target',          required: true  },
    { id: 'fuzz_parsers',            label: 'Fuzz tests on input parsers pass',                     required: true  },
    { id: 'hil_smoke',               label: 'Hardware-in-the-loop smoke test passes',               required: true,  notes: 'software-only tests catch ~30% of real bugs' },
    { id: 'power_budget',            label: 'Power consumption within target',                      required: true  },
    { id: 'signed_image',            label: 'Firmware image signed with secure-boot key',           required: true  },
    { id: 'dual_bank_layout',        label: 'Image fits in OTA bank with rollback partition free',  required: true  },
    { id: 'compliance_traceability', label: 'Requirements-to-tests traceability matrix updated',    required: true,  notes: 'needed for FCC/CE/UL/FDA audits' },
  ],
  validationMatrix: [
    { axis: 'Hardware revision', values: ['rev-A', 'rev-B', 'rev-C'], rationale: 'hardware varies across batches' },
    { axis: 'Environment',       values: ['nominal', 'high-temp', 'low-temp', 'low-voltage'], rationale: 'real-world conditions' },
    { axis: 'Network',           values: ['cellular', 'wifi', 'offline'], rationale: 'IoT often degraded' },
  ],
  rolloutStages: [
    { name: 'HIL lab',      trafficPct: 0,   minHours: 168, rollbackCriteria: ['any HIL failure'],                  observabilitySLOs: ['oscilloscope-verified timing', 'power within budget'] },
    { name: 'Field beta 5%', trafficPct: 5,  minHours: 168, rollbackCriteria: ['post-update failure rate > 1%'],   observabilitySLOs: ['telemetry from > 95% of fleet'] },
    { name: 'Field 25%',     trafficPct: 25, minHours: 168, rollbackCriteria: ['post-update failure rate > 0.5%'], observabilitySLOs: [] },
    { name: 'Field 100%',    trafficPct: 100, minHours: 0,  rollbackCriteria: [],                                   observabilitySLOs: [] },
  ],
  specialistAgents: ['hil_test_orchestrator', 'firmware_reproducibility_agent', 'ota_campaign_manager', 'compliance_evidence_curator', 'fleet_health_monitor', 'power_optimization_agent'],
  criticalRisks: [
    'Bricked devices may require physical recovery — dual-bank rollback partition is non-negotiable',
    '5-20 year product lifecycles mean you support deployed devices on old toolchains',
    'Certification (FCC/CE/UL/FDA/FIPS) requires document trails maintained continuously',
    'Hardware variation across batches means software must adapt to undocumented quirks',
    'Supply chain attacks extend into hardware — secure boot + hardware root of trust mandatory',
  ],
}

const WEB: PipelineAdapter = {
  type: 'web',
  description: 'Browser app — instant deploy, no gatekeeper.',
  preMergeChecks: [
    { id: 'typecheck',       label: 'TypeScript typecheck clean',       required: true },
    { id: 'lint',            label: 'ESLint clean',                     required: true },
    { id: 'tests',           label: 'Test suite passes',                required: true },
    { id: 'build',           label: 'Production build succeeds',        required: true },
    { id: 'bundle_size',     label: 'Bundle size within budget',        required: true },
    { id: 'a11y',            label: 'axe-core a11y scan clean',         required: true },
    { id: 'lighthouse',      label: 'Lighthouse perf budget met',       required: false },
  ],
  validationMatrix: [
    { axis: 'Browser',  values: ['Chrome', 'Safari', 'Firefox', 'Edge'], rationale: 'cross-browser parity' },
    { axis: 'Viewport', values: ['mobile', 'tablet', 'desktop', 'ultrawide'], rationale: 'responsive layout' },
  ],
  rolloutStages: [
    { name: 'Preview',       trafficPct: 0,   minHours: 1,  rollbackCriteria: ['typecheck regression'],            observabilitySLOs: [] },
    { name: 'Canary',        trafficPct: 5,   minHours: 4,  rollbackCriteria: ['error rate 2× baseline'],          observabilitySLOs: ['Core Web Vitals'] },
    { name: 'Full',          trafficPct: 100, minHours: 0,  rollbackCriteria: [],                                  observabilitySLOs: [] },
  ],
  specialistAgents: ['frontend_agent', 'a11y_audit_agent', 'perf_audit_agent'],
  criticalRisks: [
    'Edge / CDN caches can serve stale assets — cache-bust strategy mandatory',
    'CORS / CSP regressions are invisible until specific browsers hit them',
  ],
}

const BROWSER_EXT: PipelineAdapter = {
  ...WEB,
  type: 'browser_extension',
  description: 'Browser extension — Chrome / Firefox / Edge store reviews per platform.',
  preMergeChecks: [
    ...WEB.preMergeChecks,
    { id: 'manifest_v3',     label: 'manifest.json v3 compliant',                 required: true },
    { id: 'permissions_min', label: 'No new permissions vs prior version',        required: true, notes: 'permission additions trigger longer review' },
    { id: 'csp_compliant',   label: 'No inline scripts; CSP-clean',               required: true },
  ],
  rolloutStages: [
    { name: 'Unpacked dev',  trafficPct: 0,   minHours: 24,  rollbackCriteria: ['any console error on load'], observabilitySLOs: [] },
    { name: 'Chrome beta',   trafficPct: 0,   minHours: 72,  rollbackCriteria: ['extension errors > 1%'],     observabilitySLOs: [] },
    { name: 'Chrome store',  trafficPct: 100, minHours: 0,   rollbackCriteria: [],                            observabilitySLOs: [] },
  ],
  specialistAgents: [...WEB.specialistAgents, 'extension_review_agent'],
}

const DESKTOP: PipelineAdapter = {
  type: 'desktop',
  description: 'Desktop software via Electron / Tauri / native.',
  preMergeChecks: [
    { id: 'code_signed_mac',   label: 'macOS code-signed + notarised',     required: true },
    { id: 'code_signed_win',   label: 'Windows code-signed (Authenticode)', required: true },
    { id: 'auto_update',       label: 'Auto-update channel pinned',        required: true },
    { id: 'crash_reporter',    label: 'Crash reporter wired (Sentry)',     required: true },
  ],
  validationMatrix: [
    { axis: 'OS',     values: ['macOS 14', 'macOS 15', 'Windows 11', 'Ubuntu 22'], rationale: 'min-supported OS matrix' },
    { axis: 'Arch',   values: ['arm64', 'x86_64'], rationale: 'Apple Silicon + Intel + Windows ARM/x86' },
  ],
  rolloutStages: [
    { name: 'Beta channel',  trafficPct: 0, minHours: 72, rollbackCriteria: ['crash rate > 1%'], observabilitySLOs: [] },
    { name: 'Stable',        trafficPct: 100, minHours: 0, rollbackCriteria: [], observabilitySLOs: [] },
  ],
  specialistAgents: ['desktop_agent', 'code_signing_agent', 'crash_triage_agent'],
  criticalRisks: [
    'Notarisation can fail asynchronously — submit + poll workflow needed',
    'Auto-update misconfigurations brick installed apps — extensive QA on the update path itself',
  ],
}

const API_SDK: PipelineAdapter = {
  type: 'api_sdk',
  description: 'Public API + multi-language SDKs.',
  preMergeChecks: [
    { id: 'contract_test',       label: 'OpenAPI / GraphQL schema diff reviewed',           required: true },
    { id: 'backward_compat',     label: 'No breaking changes without deprecation period',  required: true },
    { id: 'sdk_regenerated',     label: 'SDKs regenerated for all supported languages',    required: true },
    { id: 'changelog_published', label: 'Changelog entry written',                          required: true },
    { id: 'rate_limit_test',     label: 'Rate-limit behavior verified',                     required: true },
  ],
  validationMatrix: [
    { axis: 'SDK language', values: ['python', 'typescript', 'go', 'ruby', 'java'], rationale: 'covers most consumers' },
    { axis: 'Auth',         values: ['api_key', 'oauth2', 'jwt'], rationale: 'every supported auth path' },
  ],
  rolloutStages: [
    { name: 'Preview API',  trafficPct: 0, minHours: 168, rollbackCriteria: ['developer complaint cluster'], observabilitySLOs: [] },
    { name: 'GA',           trafficPct: 100, minHours: 0,  rollbackCriteria: [],                              observabilitySLOs: [] },
  ],
  specialistAgents: ['api_design_agent', 'docs_generator_agent', 'sdk_codegen_agent'],
  criticalRisks: [
    'Breaking changes shipped without deprecation period destroy developer trust',
    'Rate-limit and quota tuning is operational, not design — needs continuous adjustment',
  ],
}

const ADAPTERS: Record<ProductPipelineType, PipelineAdapter> = {
  web:                WEB,
  mobile_ios:         MOBILE_IOS,
  mobile_android:     MOBILE_ANDROID,
  mobile_rn:          MOBILE_RN,
  ai_product:         AI_PRODUCT,
  embedded_firmware:  EMBEDDED,
  browser_extension:  BROWSER_EXT,
  desktop:            DESKTOP,
  api_sdk:            API_SDK,
}

export function getPipelineAdapter(type: ProductPipelineType): PipelineAdapter {
  return ADAPTERS[type]
}

export function listPipelineAdapters(): PipelineAdapter[] {
  return Object.values(ADAPTERS)
}
