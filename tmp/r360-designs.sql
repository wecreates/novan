COPY (
  SELECT id || chr(124) || prompt || chr(124) || image_url
  FROM design_catalog
  WHERE id IN (
    '019ea9c0-3317-71f8-905b-98aacad62766',
    '019ea9c0-3cda-75ab-8aa2-17db137eddf3',
    '019ea9c0-4fb7-742c-a1ce-d99e959e7490',
    '019ea9c0-462d-7461-b5db-7c1fd226912e'
  )
) TO STDOUT;
