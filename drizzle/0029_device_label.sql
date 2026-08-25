-- An operator's own name for a display, or null for "has none".
--
-- Not unique and not required: two floors may each hold a sign called "Foyer",
-- and demanding a name at enrolment would put a dialogue in front of a display
-- that is otherwise provisioned by voucher with nobody present.
--
-- Unmodified drizzle-kit output.
ALTER TABLE "devices" ADD COLUMN "label" text;
