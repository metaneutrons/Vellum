-- Sites: a physical location, and the settings layer that belongs to it.
--
-- A site owns two things nothing else can: the timezone, without which schedule
-- rules are meaningless, and defaults for the displays in it. Schedule rules were
-- previously judged by the server's clock, which was correct only because the
-- container happens to run Europe/Berlin.
--
-- Both device columns are nullable and neither cascades: a display may belong to
-- no site, and deleting a location must not delete the displays in it. That is
-- also what lets this migration avoid inventing a site for existing devices.
--
-- Unmodified drizzle-kit output.
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"refresh_profile_id" uuid,
	"theme_id" uuid,
	"content_instance_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "site_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_refresh_profile_id_refresh_profiles_id_fk" FOREIGN KEY ("refresh_profile_id") REFERENCES "public"."refresh_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_content_instance_id_content_instances_id_fk" FOREIGN KEY ("content_instance_id") REFERENCES "public"."content_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;