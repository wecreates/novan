/**
 * Policy registry — all built-in policies.
 */
export { browserExecutionPolicy }    from './browser.js'
export { fileActionPolicy }          from './file.js'
export { contentPublishingPolicy }   from './publish.js'
export { financialActionPolicy }     from './financial.js'
export { workflowExecutionPolicy }   from './workflow.js'
export { automationFrequencyPolicy } from './frequency.js'
export { providerUsagePolicy }       from './provider.js'

import { browserExecutionPolicy }    from './browser.js'
import { fileActionPolicy }          from './file.js'
import { contentPublishingPolicy }   from './publish.js'
import { financialActionPolicy }     from './financial.js'
import { workflowExecutionPolicy }   from './workflow.js'
import { automationFrequencyPolicy } from './frequency.js'
import { providerUsagePolicy }       from './provider.js'
import type { Policy, ActionCategory } from '../types.js'

/** All built-in policies, keyed by category. */
export const POLICIES_BY_CATEGORY: Record<ActionCategory, Policy[]> = {
  browser:    [browserExecutionPolicy],
  file:       [fileActionPolicy],
  publish:    [contentPublishingPolicy],
  financial:  [financialActionPolicy],
  workflow:   [workflowExecutionPolicy],
  automation: [automationFrequencyPolicy],
  provider:   [providerUsagePolicy],
  memory:     [],
  agent:      [],
}

/** All built-in policies as a flat array. */
export const ALL_POLICIES: Policy[] = [
  browserExecutionPolicy,
  fileActionPolicy,
  contentPublishingPolicy,
  financialActionPolicy,
  workflowExecutionPolicy,
  automationFrequencyPolicy,
  providerUsagePolicy,
]
