# Load testing — R146.133

## Setup

```bash
# Install k6 (one-time)
curl -L https://github.com/grafana/k6/releases/download/v0.50.0/k6-v0.50.0-linux-amd64.tar.gz | tar xz
sudo mv k6-v0.50.0-linux-amd64/k6 /usr/local/bin/
```

## Run

```bash
# Against the live droplet
k6 run -e BASE_URL=https://137.184.198.2 -e TOKEN="$NOVAN_SESSION_COOKIE" tests/load/k6-novan.js

# Or local dev
k6 run -e BASE_URL=http://localhost:3001 tests/load/k6-novan.js
```

## Interpreting results

The thresholds defined in the script:

| Scenario | p95 target | Acceptable error rate |
|---|---|---|
| `health` | < 300 ms | < 1% |
| `brain_op` (1→20 VUs ramp) | < 1000 ms | < 1% |
| `autonomy_counts` (5 VUs steady) | < 800 ms | < 1% |

**Capacity model output to record:**
- Max sustained RPS where p95 < 1s and error rate < 1%
- Token cost ($0/req for read ops; ~$0.0003 for any LLM-touching op)
- Memory ceiling reached on the API container
- DB connection pool saturation point

Re-run quarterly or after major infra changes. Stash results in `tests/load/results/<date>.json`.
