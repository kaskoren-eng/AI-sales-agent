CREATE TABLE "call_learnings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "conference_name" varchar(64),
  "conference_sid" varchar(64),
  "recording_sid" varchar(64),
  "recording_url" varchar(512),
  "transcript" jsonb DEFAULT '[]'::jsonb,
  "analysis" jsonb DEFAULT '{}'::jsonb,
  "outcome" varchar(20),
  "duration_secs" integer,
  "label" varchar(255),
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
