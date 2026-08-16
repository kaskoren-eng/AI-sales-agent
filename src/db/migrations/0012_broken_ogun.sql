CREATE TABLE "oauth_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" varchar(40) NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"access_token_encrypted" text,
	"access_token_expires_at" timestamp with time zone,
	"account_email" varchar(255),
	"calendar_id" varchar(255) DEFAULT 'primary' NOT NULL,
	"scope" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_connections_tenant_provider_key" ON "oauth_connections" USING btree ("tenant_id","provider");