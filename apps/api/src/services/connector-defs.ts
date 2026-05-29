/**
 * connector-defs.ts — re-exports the catalog for the seed routine.
 *
 * Definitions themselves live one-per-file under `connector-catalog/`.
 * This file used to inline the 4 first-wave defs; now it just re-exports.
 */
import { CATALOG } from './connector-catalog/index.js'
import { registerActionDescriptor } from './connectors.js'

export const FIRST_CONNECTOR_DEFS = CATALOG

/**
 * Register every action's descriptor (risk + min permission + scopes)
 * in-process. Must be called before any dispatchAction() that targets
 * these actions — `seedConnectorRegistry()` calls this automatically.
 */
export function registerFirstConnectorDescriptors() {
  for (const def of CATALOG) {
    for (const a of def.actions) {
      registerActionDescriptor(a.name, {
        risk:          a.risk,
        minPermission: a.minPermission,
        ...(a.requiredScopes ? { requiredScopes: a.requiredScopes } : {}),
      })
    }
  }
}
