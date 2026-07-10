DELETE FROM events WHERE received_at < now() - interval '90 days';

DELETE FROM rate_counter WHERE hour_bucket < to_char((now() - interval '2 days'), 'YYYY-MM-DD"T"HH24');
DELETE FROM heartbeat_dedupe WHERE received_at < now() - interval '7 days';
