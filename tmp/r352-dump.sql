COPY (
  SELECT json_build_object(
    'platform',    platform,
    'title',       title,
    'description', regexp_replace(replace(description, E'\r', ''), E'\n', '\\n', 'g'),
    'tags',        tags,
    'price',       price_usd::text,
    'priority',    priority,
    'design_id',   design_id
  )::text
  FROM design_upload_queue
  WHERE workspace_id = 'default' AND status = 'queued'
  ORDER BY platform, priority DESC, queued_at ASC
) TO STDOUT;
