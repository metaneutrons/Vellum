-- Extend authenticated desired-state commands with encrypted-at-rest Wi-Fi
-- changes. The password remains inside the encrypted JSON payload and is only
-- decrypted while constructing the device-authenticated response.
ALTER TABLE "device_configuration_commands"
  DROP CONSTRAINT IF EXISTS "device_configuration_commands_kind_check";
ALTER TABLE "device_configuration_commands"
  ADD CONSTRAINT "device_configuration_commands_kind_check"
  CHECK ("kind" IN ('server_url', 'wifi'));
