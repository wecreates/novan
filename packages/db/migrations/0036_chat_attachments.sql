-- 0036_chat_attachments.sql
-- Multimodal chat: attach images / files to a message.
--
-- We store attachments as a jsonb array of references, not binary blobs.
-- Each item: { url, mime, kind, name?, sizeBytes? }
--   url       — data: URL (base64) OR https URL the operator already hosts
--   mime      — image/png, image/jpeg, image/webp, image/gif, application/pdf, text/plain, ...
--   kind      — 'image' | 'document' | 'reference'
--   name      — optional original filename for display
--   sizeBytes — optional, populated when client knows it
--
-- This mirrors the image-studio /reference convention: we keep the URL and
-- let the chosen provider pull / decode at request time. Binary storage is
-- out of scope for this turn (would need S3 + worker scrub policies).

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb;
