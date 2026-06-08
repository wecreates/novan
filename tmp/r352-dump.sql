COPY (
  SELECT json_build_object(
    'platform',    platform,
    'title',       title,
    -- Strip ALL backslashes (descriptions had legacy JS-template backslash
    -- escapes that double-encode through json_build_object); strip CR/LF too.
    -- Description has legacy backslash escapes that break json_build_object.
    -- Use standard (non-E) string so \\ is 2 chars in input and regex sees
    -- the pattern \\ which matches a single literal backslash. Strip all
    -- backslashes, then collapse CR/LF.
    'description', regexp_replace(
                     regexp_replace(description, '\\', '', 'g'),
                     '[\r\n]+', ' ',
                     'g'
                   ),
    'tags',        tags,
    'price',       price_usd::text,
    'priority',    priority,
    'design_id',   design_id
  )::text
  FROM design_upload_queue
  WHERE workspace_id = 'default' AND status = 'queued'
  ORDER BY platform, priority DESC, queued_at ASC
) TO STDOUT;
