-- 0056 — shortform autopost approval gate (R146.116)
ALTER TABLE "shortform_pipelines" ADD COLUMN IF NOT EXISTS "auto_post_approved" boolean NOT NULL DEFAULT false;
