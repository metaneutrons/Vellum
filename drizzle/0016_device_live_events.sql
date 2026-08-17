-- Device-list invalidation is transactional: PostgreSQL delivers NOTIFY only
-- after the surrounding write commits. Identical notifications emitted by the
-- telemetry INSERT and last_seen UPDATE in one transaction are folded into one.
CREATE OR REPLACE FUNCTION vellum_notify_device_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  device_mac text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    device_mac := OLD.mac;
  ELSE
    device_mac := NEW.mac;
  END IF;
  PERFORM pg_notify(
    'vellum_device_events',
    json_build_object('mac', device_mac)::text
  );
  -- The return value of an AFTER trigger is ignored.
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS devices_live_change ON devices;
CREATE TRIGGER devices_live_change
AFTER INSERT OR UPDATE OR DELETE ON devices
FOR EACH ROW EXECUTE FUNCTION vellum_notify_device_change();

DROP TRIGGER IF EXISTS telemetry_live_change ON telemetry;
CREATE TRIGGER telemetry_live_change
AFTER INSERT ON telemetry
FOR EACH ROW EXECUTE FUNCTION vellum_notify_device_change();
