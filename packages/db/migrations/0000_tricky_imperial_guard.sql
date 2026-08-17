CREATE TABLE "job_cursor" (
	"job" varchar(48) PRIMARY KEY NOT NULL,
	"cursor" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_state" (
	"yt_channel_id" varchar(32) PRIMARY KEY NOT NULL,
	"status" varchar(8) DEFAULT 'offline' NOT NULL,
	"video_id" varchar(16),
	"scheduled_start" timestamp with time zone,
	"checked_at" timestamp with time zone NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_account" (
	"user_id" varchar(64) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_account_user_id_provider_pk" PRIMARY KEY("user_id","provider")
);
--> statement-breakpoint
CREATE TABLE "quota_ledger" (
	"day" varchar(10) PRIMARY KEY NOT NULL,
	"units" integer DEFAULT 0 NOT NULL,
	"by_method" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_patch" (
	"tv_channel_id" varchar(64) NOT NULL,
	"day_key" varchar(10) NOT NULL,
	"seq_no" integer NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"kind" varchar(24) NOT NULL,
	"video_id" varchar(16),
	"reason" text DEFAULT '' NOT NULL,
	CONSTRAINT "schedule_patch_tv_channel_id_day_key_seq_no_pk" PRIMARY KEY("tv_channel_id","day_key","seq_no")
);
--> statement-breakpoint
CREATE TABLE "schedule_slot" (
	"tv_channel_id" varchar(64) NOT NULL,
	"day_key" varchar(10) NOT NULL,
	"seq" integer NOT NULL,
	"video_id" varchar(16) NOT NULL,
	"yt_channel_id" varchar(32) NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"duration_sec" integer NOT NULL,
	"relaxed_to" integer DEFAULT 0 NOT NULL,
	"is_hot_insert" boolean DEFAULT false NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "schedule_slot_tv_channel_id_day_key_seq_pk" PRIMARY KEY("tv_channel_id","day_key","seq")
);
--> statement-breakpoint
CREATE TABLE "tv_channel" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"number" integer NOT NULL,
	"source_kind" varchar(24) NOT NULL,
	"source_spec" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mode" varchar(8) DEFAULT 'VOD' NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"region" varchar(2) DEFAULT 'BR' NOT NULL,
	"time_zone" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_channel_affinity" (
	"user_id" varchar(64) NOT NULL,
	"yt_channel_id" varchar(32) NOT NULL,
	"takeout_count" integer DEFAULT 0 NOT NULL,
	"is_subscribed" boolean DEFAULT false NOT NULL,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"internal_score" real DEFAULT 0 NOT NULL,
	"combined_score" real DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_channel_affinity_user_id_yt_channel_id_pk" PRIMARY KEY("user_id","yt_channel_id")
);
--> statement-breakpoint
CREATE TABLE "watch_event" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"video_id" varchar(16) NOT NULL,
	"yt_channel_id" varchar(32) NOT NULL,
	"watched_sec" integer NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yt_channel" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"uploads_playlist_id" varchar(34),
	"thumbnail_url" text,
	"refreshed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yt_video" (
	"id" varchar(16) PRIMARY KEY NOT NULL,
	"yt_channel_id" varchar(32) NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"duration_sec" integer,
	"category_id" varchar(8) DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"embeddable" boolean DEFAULT false NOT NULL,
	"privacy_status" varchar(16) DEFAULT 'unknown' NOT NULL,
	"upload_status" varchar(16) DEFAULT 'unknown' NOT NULL,
	"made_for_kids" boolean DEFAULT false NOT NULL,
	"blocked_regions" varchar(2)[] DEFAULT '{}' NOT NULL,
	"allowed_regions" varchar(2)[] DEFAULT '{}' NOT NULL,
	"has_content_rating" boolean DEFAULT false NOT NULL,
	"live_state" varchar(8) DEFAULT 'none' NOT NULL,
	"live_scheduled_start" timestamp with time zone,
	"live_actual_start" timestamp with time zone,
	"live_actual_end" timestamp with time zone,
	"thumbnail_url" text,
	"unplayable_at" timestamp with time zone,
	"unplayable_reason" text,
	"unplayable_code" integer,
	"refreshed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "live_state" ADD CONSTRAINT "live_state_yt_channel_id_yt_channel_id_fk" FOREIGN KEY ("yt_channel_id") REFERENCES "public"."yt_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_account" ADD CONSTRAINT "oauth_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_patch" ADD CONSTRAINT "schedule_patch_tv_channel_id_tv_channel_id_fk" FOREIGN KEY ("tv_channel_id") REFERENCES "public"."tv_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_slot" ADD CONSTRAINT "schedule_slot_tv_channel_id_tv_channel_id_fk" FOREIGN KEY ("tv_channel_id") REFERENCES "public"."tv_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tv_channel" ADD CONSTRAINT "tv_channel_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channel_affinity" ADD CONSTRAINT "user_channel_affinity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channel_affinity" ADD CONSTRAINT "user_channel_affinity_yt_channel_id_yt_channel_id_fk" FOREIGN KEY ("yt_channel_id") REFERENCES "public"."yt_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_event" ADD CONSTRAINT "watch_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yt_video" ADD CONSTRAINT "yt_video_yt_channel_id_yt_channel_id_fk" FOREIGN KEY ("yt_channel_id") REFERENCES "public"."yt_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_state_next_check_idx" ON "live_state" USING btree ("next_check_at");--> statement-breakpoint
CREATE INDEX "schedule_slot_channel_window_idx" ON "schedule_slot" USING btree ("tv_channel_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "schedule_slot_video_idx" ON "schedule_slot" USING btree ("video_id","starts_at");--> statement-breakpoint
CREATE INDEX "schedule_slot_starts_idx" ON "schedule_slot" USING btree ("starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tv_channel_user_number_idx" ON "tv_channel" USING btree ("user_id","number");--> statement-breakpoint
CREATE INDEX "affinity_user_score_idx" ON "user_channel_affinity" USING btree ("user_id","combined_score");--> statement-breakpoint
CREATE INDEX "watch_event_user_at_idx" ON "watch_event" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "yt_channel_refreshed_idx" ON "yt_channel" USING btree ("refreshed_at");--> statement-breakpoint
CREATE INDEX "yt_video_channel_idx" ON "yt_video" USING btree ("yt_channel_id");--> statement-breakpoint
CREATE INDEX "yt_video_refreshed_idx" ON "yt_video" USING btree ("refreshed_at");--> statement-breakpoint
CREATE INDEX "yt_video_channel_published_idx" ON "yt_video" USING btree ("yt_channel_id","published_at");--> statement-breakpoint
CREATE INDEX "yt_video_live_state_idx" ON "yt_video" USING btree ("live_state");