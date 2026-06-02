/**
 * R146.133 — k6 load test.
 *
 * Three scenarios:
 *   - health: 1 VU sustained, /health probe
 *   - brain_op: ramp 1→20 VUs for 3min, hammer /api/brain/op with safe read ops
 *   - autonomy_counts: 5 VUs steady for 5min, counts only
 *
 * Capacity model output: per-scenario p50 / p95 / p99 latency, error rate,
 * RPS. The "max sustained" number for the deployed droplet is whatever
 * RPS keeps error rate < 1% and p95 < 1s.
 *
 * Run: k6 run -e BASE_URL=https://137.184.198.2 -e TOKEN=$NOVAN_TOKEN tests/load/k6-novan.js
 */
import http from 'k6/http'
import { check, sleep } from 'k6'

const BASE = __ENV.BASE_URL || 'http://localhost:3001'
const TOKEN = __ENV.TOKEN || ''

export const options = {
  scenarios: {
    health: {
      executor: 'constant-vus',
      vus: 1, duration: '5m',
      exec: 'healthProbe',
      tags: { scenario: 'health' },
    },
    brain_op: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 5 },
        { duration: '1m',  target: 20 },
        { duration: '1m',  target: 20 },
        { duration: '30s', target: 0 },
      ],
      exec: 'brainOp',
      tags: { scenario: 'brain_op' },
    },
    autonomy_counts: {
      executor: 'constant-vus',
      vus: 5, duration: '5m',
      exec: 'autonomyCounts',
      tags: { scenario: 'autonomy_counts' },
    },
  },
  thresholds: {
    'http_req_duration{scenario:health}':          ['p(95)<300'],
    'http_req_duration{scenario:brain_op}':        ['p(95)<1000'],
    'http_req_duration{scenario:autonomy_counts}': ['p(95)<800'],
    'http_req_failed':                              ['rate<0.01'],
  },
}

const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { Cookie: `novan-session=${TOKEN}` } : {}) }

export function healthProbe() {
  const r = http.get(`${BASE}/api/v1/health`, { headers, tags: { name: 'health' } })
  check(r, { 'health 2xx': res => res.status >= 200 && res.status < 300 })
  sleep(1)
}

const SAFE_OPS = [
  'novan.capabilities',
  'autonomy.counts',
  'quota.summary',
  'proposals.list',
  'patches.list',
  'attribution.list',
  'spend.status',
  'agents.list',
]
export function brainOp() {
  const op = SAFE_OPS[Math.floor(Math.random() * SAFE_OPS.length)]
  const r = http.post(`${BASE}/api/brain/op`, JSON.stringify({ op, params: {} }), { headers, tags: { name: 'brain_op', op } })
  check(r, { 'brain_op 2xx or 401': res => res.status === 200 || res.status === 401 })
  sleep(0.5)
}

export function autonomyCounts() {
  const r = http.post(`${BASE}/api/brain/op`, JSON.stringify({ op: 'autonomy.counts', params: {} }), { headers, tags: { name: 'autonomy_counts' } })
  check(r, { 'counts ok': res => res.status === 200 || res.status === 401 })
  sleep(2)
}
