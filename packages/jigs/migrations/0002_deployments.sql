CREATE TABLE "jigs_deployments" (
  "factory" text NOT NULL,
  "version" text NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz,
  "pid" integer,
  "host" text,
  "current" boolean NOT NULL DEFAULT false,
  "made_current_at" timestamptz,
  "superseded_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("factory", "version")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "jigs_deployments_current" ON "jigs_deployments" ("factory") WHERE "current";
--> statement-breakpoint
CREATE TABLE "jigs_live_turn_messages" (
  "id" bigserial PRIMARY KEY,
  "factory" text NOT NULL,
  "token" text NOT NULL,
  "kind" text NOT NULL,
  "payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "taken_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX "jigs_live_turn_messages_token" ON "jigs_live_turn_messages" ("factory", "token");
