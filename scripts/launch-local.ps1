# Novan — one-command local launch
# Boots: API on :3001, web on :5173
# Connects to: Neon Postgres + Upstash Redis + Gemini

$env:DATABASE_URL      = "postgresql://neondb_owner:npg_n2wGjmuWzrU9@ep-bitter-snow-ak0w2voz-pooler.c-3.us-west-2.aws.neon.tech/neondb?sslmode=require"
$env:REDIS_URL         = "rediss://default:gQAAAAAAAewCAAIgcDIzOWIwNjU2NjA3MTY0MzRhODExNmZkOGEwYjJlY2QwNA@lucky-anemone-125954.upstash.io:6379"
$env:AUTH_SECRET       = "VSgXZQD6x4S+2boM+cJAvNbEd93oL7af+fy0nSXI6QRribja6DIhSupgEHAjTqUK"
$env:VAULT_MASTER_KEY  = "L3ysQ8LdgB0I/R7gXdRzIcERe753TQVkH9N7f+OGfqY="
$env:GEMINI_API_KEY    = "AIzaSyBm3feOLMYlfzqtxKGA9UMF18bUQDwstNM"
$env:CORS_ORIGINS      = "http://localhost:5173,http://localhost:3000"
$env:RUNTIME_MODE      = "cloud-api-only"
$env:NODE_ENV          = "development"
$env:API_PORT          = "3001"
$env:VITE_API_BASE_URL = "http://localhost:3001"
$env:PROVIDER_ROUTER_ENABLED = "true"
$env:BUDGET_GUARDS_ENABLED   = "true"
$env:KILL_SWITCH_ENABLED     = "true"

Write-Host ""
Write-Host "  Novan — starting locally" -ForegroundColor Cyan
Write-Host "  API:  http://localhost:3001" -ForegroundColor Green
Write-Host "  Web:  http://localhost:5173" -ForegroundColor Green
Write-Host "  Docs: http://localhost:3001/docs (if Node 20)" -ForegroundColor Gray
Write-Host ""
Write-Host "  Press Ctrl+C to stop both" -ForegroundColor Yellow
Write-Host ""

# Run API + web in parallel (skip admin/workers/etc)
& pnpm exec turbo run dev --parallel --filter=@ops/api --filter=@ops/web
