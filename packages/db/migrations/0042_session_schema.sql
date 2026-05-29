CREATE TABLE IF NOT EXISTS "entity_relationships" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"relationship" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rel_workspace_idx" ON "entity_relationships" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rel_source_idx" ON "entity_relationships" USING btree ("source_kind","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rel_target_idx" ON "entity_relationships" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rel_unique_idx" ON "entity_relationships" USING btree ("workspace_id","source_kind","source_id","target_kind","target_id","relationship");