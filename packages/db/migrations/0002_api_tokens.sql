CREATE TABLE IF NOT EXISTS "api_tokens" (
  "id"           text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "name"         text NOT NULL,
  "token_hash"   text NOT NULL UNIQUE,
  "prefix"       text NOT NULL,
  "scopes"       text[] NOT NULL DEFAULT ARRAY['read','write'],
  "last_used_at" bigint,
  "expires_at"   bigint,
  "revoked_at"   bigint,
  "created_at"   bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "token_hash_idx"      ON "api_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "token_workspace_idx" ON "api_tokens" ("workspace_id");
