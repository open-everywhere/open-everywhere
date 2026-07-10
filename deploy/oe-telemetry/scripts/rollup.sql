INSERT INTO event_rollup_daily (day, event_name, service_version, surface, model, event_count, distinct_instances)
SELECT
  (received_at AT TIME ZONE 'UTC')::date AS day,
  event_name,
  COALESCE(resource ->> 'service.version', '')        AS service_version,
  COALESCE(attributes ->> 'oe.surface', '')            AS surface,
  COALESCE(attributes ->> 'gen_ai.request.model', '')  AS model,
  COUNT(*)                    AS event_count,
  COUNT(DISTINCT instance_id) AS distinct_instances
FROM events
WHERE received_at < date_trunc('day', now() AT TIME ZONE 'UTC')
GROUP BY 1, 2, 3, 4, 5
ON CONFLICT (day, event_name, service_version, surface, model)
DO UPDATE SET
  event_count        = EXCLUDED.event_count,
  distinct_instances = EXCLUDED.distinct_instances;
