ALTER TABLE "leads" ADD COLUMN "last_inbound_whatsapp_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "whatsapp_consent" jsonb;