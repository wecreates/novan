-- Mark the peony as uploaded + clean up the duplicate (we created 2 because mark_uploaded was failing)
UPDATE design_upload_queue
SET status = 'uploaded',
    uploaded_at = EXTRACT(EPOCH FROM NOW())::bigint * 1000,
    external_url = 'https://cyzorcreations.gumroad.com/l/peony-print-instant-download'
WHERE workspace_id = 'default'
  AND platform = 'gumroad'
  AND design_id IN (
    SELECT design_id FROM design_upload_queue
    WHERE workspace_id = 'default' AND platform = 'gumroad'
    ORDER BY priority DESC, queued_at ASC
    LIMIT 1
  );

SELECT platform, status, count(*)
FROM design_upload_queue
WHERE workspace_id = 'default' AND platform = 'gumroad'
GROUP BY platform, status;

SELECT id, status, external_url, left(title, 50)
FROM design_upload_queue
WHERE workspace_id = 'default' AND platform = 'gumroad' AND status = 'uploaded'
LIMIT 5;
