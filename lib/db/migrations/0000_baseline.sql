CREATE TABLE "activity_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"actor_avatar_url" text,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"week_start" date NOT NULL,
	"amount" integer DEFAULT 250 NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"action" text NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"actor_ip" text,
	"actor_ua" text,
	"target_type" text,
	"target_id" text,
	"message" text,
	"before_json" jsonb,
	"after_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_actor_attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer,
	"user_id" text NOT NULL,
	"username" text,
	"mission_id" text,
	"mission_name" text,
	"fixer_id" text,
	"fixer_username" text,
	"pay_amount" integer DEFAULT 0 NOT NULL,
	"acted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bot_actor_attendance_bot_id_unique" UNIQUE("bot_id")
);
--> statement-breakpoint
CREATE TABLE "bot_attendance_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"logged_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_balance_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer,
	"user_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"cash_delta" integer DEFAULT 0 NOT NULL,
	"bank_delta" integer DEFAULT 0 NOT NULL,
	"reason" text,
	CONSTRAINT "bot_balance_history_bot_id_unique" UNIQUE("bot_id")
);
--> statement-breakpoint
CREATE TABLE "bot_business_open_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_cyberware_status" (
	"user_id" text PRIMARY KEY NOT NULL,
	"weeks" integer DEFAULT 0 NOT NULL,
	"last_processed" timestamp with time zone,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bot_cyberware_weekly_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer,
	"run_at" timestamp with time zone NOT NULL,
	"checkup_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paid_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unpaid_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "bot_cyberware_weekly_runs_bot_id_unique" UNIQUE("bot_id")
);
--> statement-breakpoint
CREATE TABLE "bot_last_payment" (
	"user_id" text PRIMARY KEY NOT NULL,
	"summary" text,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bot_mission_log" (
	"user_id" text PRIMARY KEY NOT NULL,
	"username" text,
	"mission_count" integer DEFAULT 0 NOT NULL,
	"mission_dates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mission_titles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bot_payment_labels" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_player_inventory" (
	"item_id" text PRIMARY KEY NOT NULL,
	"owner_id" text,
	"character_id" text,
	"character_name" text,
	"item_type" text,
	"name" text,
	"restriction" text,
	"description" text,
	"price_paid" integer,
	"seller_id" text,
	"seller_name" text,
	"acquired_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"power_level" text,
	"weapon_subtype" text,
	"cwp" text,
	"slot" text,
	"weapon_type" text
);
--> statement-breakpoint
CREATE TABLE "bot_rent_payment_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"week" integer,
	CONSTRAINT "bot_rent_payment_events_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "bot_rent_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer,
	"run_at" timestamp with time zone NOT NULL,
	"initiated_by" text,
	CONSTRAINT "bot_rent_runs_bot_id_unique" UNIQUE("bot_id")
);
--> statement-breakpoint
CREATE TABLE "bot_store_inventory" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer,
	"store_id" text NOT NULL,
	"lot_id" text,
	"gun_name" text,
	"gun_level" text,
	"unit_cost" integer DEFAULT 0 NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	"item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"restriction" text,
	"weapon_type" text,
	"gun_category" text,
	"created_at" timestamp with time zone,
	CONSTRAINT "bot_store_inventory_bot_id_unique" UNIQUE("bot_id")
);
--> statement-breakpoint
CREATE TABLE "bot_ticket_index" (
	"message_id" text PRIMARY KEY NOT NULL,
	"url" text,
	"ts" timestamp with time zone,
	"title" text,
	"body" text
);
--> statement-breakpoint
CREATE TABLE "breach_practice_clears" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"difficulty" text NOT NULL,
	"clear_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "breach_practice_stats" (
	"user_id" text NOT NULL,
	"difficulty" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"solves" integer DEFAULT 0 NOT NULL,
	"fastest_clear_ms" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "breach_practice_stats_user_id_difficulty_pk" PRIMARY KEY("user_id","difficulty")
);
--> statement-breakpoint
CREATE TABLE "breach_puzzles" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_by" text NOT NULL,
	"assigned_user_id" text NOT NULL,
	"assigned_character_id" integer,
	"assigned_character_name" text,
	"difficulty" text NOT NULL,
	"time_limit_seconds" integer NOT NULL,
	"grid" jsonb NOT NULL,
	"daemons" jsonb NOT NULL,
	"buffer_size" integer NOT NULL,
	"solution_count" integer NOT NULL,
	"reward_eddies" integer DEFAULT 0 NOT NULL,
	"reward_item_name" text,
	"reward_item_category" text,
	"reward_note" text,
	"context_label" text,
	"mission_id" integer,
	"status" text DEFAULT 'sent' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"selection" jsonb,
	"solved_count" integer DEFAULT 0 NOT NULL,
	"time_taken_seconds" integer,
	"reward_paid_at" timestamp with time zone,
	"reward_ledger_id" integer,
	"reward_item_id" integer,
	"dm_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_cyberware" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slot" text NOT NULL,
	"humanity_loss" integer DEFAULT 0 NOT NULL,
	"cwp" text,
	"price" integer DEFAULT 0 NOT NULL,
	"wholesale_price" integer,
	"install_cost" integer,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "catalog_districts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_districts_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "catalog_guns" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"manufacturer" text,
	"damage" text,
	"mag_size" integer,
	"price" integer DEFAULT 0 NOT NULL,
	"wholesale_price" integer,
	"restriction" text,
	"status" text,
	"power_level" text,
	"weapon_type" text,
	"fire_mode" text,
	"notes" text,
	"image_url" text,
	"cyberware_req" text,
	"wiki_url" text,
	"prefab_thread_url" text
);
--> statement-breakpoint
CREATE TABLE "catalog_rent" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"district" text,
	"tier" text,
	"monthly_rent" integer DEFAULT 0 NOT NULL,
	"description" text,
	"image_url" text,
	"kind" text DEFAULT 'residential' NOT NULL,
	"leasable" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_sheets" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"character_id" integer,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"data" jsonb NOT NULL,
	"decision_by" text,
	"decision_note" text,
	"overridden_by" text,
	"decided_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"closed_outcome" text,
	"discord_message_id" text,
	"discord_thread_id" text,
	"submitted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_status" (
	"character_id" integer PRIMARY KEY NOT NULL,
	"loa" boolean DEFAULT false NOT NULL,
	"loa_returns_at" timestamp with time zone,
	"attending" boolean DEFAULT false NOT NULL,
	"open_shop" boolean DEFAULT false NOT NULL,
	"status_message" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_tag_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"discord_role_id" text,
	"requires_approval" boolean DEFAULT false NOT NULL,
	CONSTRAINT "character_tag_options_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "character_updates" (
	"id" serial PRIMARY KEY NOT NULL,
	"character_id" integer NOT NULL,
	"author_id" text,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_week_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"week_start" date NOT NULL,
	"character_id" integer NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"life_status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" text,
	"claimed" boolean DEFAULT true NOT NULL,
	"legacy_discord_username" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"archetype" text,
	"background" text,
	"portrait_url" text,
	"portrait_urls" text[] DEFAULT '{}' NOT NULL,
	"stats_image_urls" text[] DEFAULT '{}' NOT NULL,
	"sheet_data" jsonb,
	"imported_from_thread_id" text,
	"imported_from_channel_name" text,
	"applied_tags" text[] DEFAULT '{}' NOT NULL,
	"manual_tags" text[] DEFAULT '{}' NOT NULL,
	"fixer_discord_id" text,
	"player_discord_id" text,
	"discord_channel_id" text,
	"life_status" text DEFAULT 'active' NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"lifestyle_tier_id" integer,
	"trauma_team_tier" text,
	"xanadu_gold" boolean DEFAULT false NOT NULL,
	"last_checkup_at" timestamp with time zone,
	"checkup_streak" integer DEFAULT 0 NOT NULL,
	"cyberware_level" text DEFAULT 'none' NOT NULL,
	"is_organic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"character_id" integer NOT NULL,
	"requested_by_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"image_url" text,
	"image_urls" jsonb,
	"details" jsonb,
	"reserved_listing_id" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by_id" text,
	"reviewed_at" timestamp with time zone,
	"reviewer_note" text,
	"overridden_by" text,
	"applied_ref" text,
	"decision_params" jsonb,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"closed_outcome" text,
	"discord_message_id" text,
	"discord_thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dice_rolls" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text,
	"character_id" integer,
	"character_name" text,
	"expression" text NOT NULL,
	"label" text,
	"rolls" integer[] NOT NULL,
	"modifier" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_checkin_staff" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"added_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_npc_signups" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"character_id" integer,
	"note" text,
	"occurrence_start_at" timestamp with time zone,
	"state" text DEFAULT 'signed_up' NOT NULL,
	"pay_amount" integer,
	"payment_status" text DEFAULT 'unpaid' NOT NULL,
	"payment_error" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_ticket_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price" integer DEFAULT 0 NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"ticket_type_id" integer NOT NULL,
	"buyer_user_id" text NOT NULL,
	"price_paid" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payout_status" text DEFAULT 'none' NOT NULL,
	"payout_error" text,
	"attended_at" timestamp with time zone,
	"attended_by_id" text,
	"refunded_at" timestamp with time zone,
	"refunded_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"event_type" text DEFAULT 'social' NOT NULL,
	"location" text,
	"description" text,
	"image_url" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"needs_npcs" boolean DEFAULT false NOT NULL,
	"npc_blurb" text,
	"created_by_id" text,
	"discord_event_id" text,
	"discord_sync_error" text,
	"discord_synced_hash" text,
	"discord_synced_at" timestamp with time zone,
	"recurrence_rule" jsonb,
	"excluded_occurrences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vrchat_calendar_id" text,
	"vrchat_sync_error" text,
	"vrchat_synced_hash" text,
	"vrchat_synced_at" timestamp with time zone,
	"ticket_payout_mode" text DEFAULT 'runner' NOT NULL,
	"ticket_runner_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_session_not_recurring" CHECK ("events"."event_type" <> 'session' OR "events"."recurrence_rule" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "fixer_npcs" (
	"id" serial PRIMARY KEY NOT NULL,
	"fixer_id" text NOT NULL,
	"name" text NOT NULL,
	"archetype" text,
	"district" text,
	"description" text,
	"portrait_url" text,
	"contact" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guidebook_pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"section" text DEFAULT 'misc' NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"body" text DEFAULT '' NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"discord_channel_id" text,
	"source_label" text,
	"imported_at" timestamp with time zone,
	"edited_since_import" boolean DEFAULT false NOT NULL,
	"public_read" boolean DEFAULT false NOT NULL,
	"pending_import" jsonb,
	"pending_import_at" timestamp with time zone,
	"created_by_id" text,
	"updated_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guidebook_pending_edits" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_id" integer,
	"kind" text DEFAULT 'edit' NOT NULL,
	"submitted_by" text NOT NULL,
	"proposed_diff" jsonb NOT NULL,
	"before_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"update_note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_id" text,
	"decided_at" timestamp with time zone,
	"decision_summary" text,
	"applied_page_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "housing" (
	"id" serial PRIMARY KEY NOT NULL,
	"character_id" integer NOT NULL,
	"listing_id" integer,
	"address" text NOT NULL,
	"district" text,
	"tier" text,
	"monthly_rent" integer DEFAULT 0 NOT NULL,
	"kind" text DEFAULT 'residential' NOT NULL,
	"paid_through" timestamp with time zone,
	"delinquent_since" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "housing_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"character_id" integer NOT NULL,
	"listing_id" integer NOT NULL,
	"requested_by_id" text NOT NULL,
	"kind" text DEFAULT 'residential' NOT NULL,
	"notes" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by_id" text,
	"reviewed_at" timestamp with time zone,
	"reviewer_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "income_command_uses" (
	"user_id" text NOT NULL,
	"command" text NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "income_command_uses_user_id_command_pk" PRIMARY KEY("user_id","command")
);
--> statement-breakpoint
CREATE TABLE "inventory_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_uuid" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"from_character_id" integer,
	"from_character_name" text,
	"to_character_id" integer,
	"to_character_name" text,
	"item_name" text NOT NULL,
	"quantity" integer,
	"price" integer,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"character_id" integer,
	"owner_id" text,
	"name" text NOT NULL,
	"category" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"cyberware_req" text,
	"equipped" boolean DEFAULT false NOT NULL,
	"price_paid" integer,
	"acquired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_items_instance_uuid_unique" UNIQUE("instance_uuid")
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"message" text,
	"affected_count" integer
);
--> statement-breakpoint
CREATE TABLE "lifestyle_tiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"monthly_cost" integer DEFAULT 0 NOT NULL,
	"description" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lore_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text DEFAULT 'misc' NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"responsible_fixer" text,
	"summary" text,
	"image_url" text,
	"district" text,
	"sub_district" text,
	"public_body" text DEFAULT '' NOT NULL,
	"fixer_body" text,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_id" text,
	"updated_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lore_import_drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_key" text NOT NULL,
	"proposed_name" text NOT NULL,
	"proposed_category" text DEFAULT 'misc' NOT NULL,
	"proposed_fixer" text,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"summary" text,
	"image_url" text,
	"district" text,
	"sub_district" text,
	"public_body" text DEFAULT '' NOT NULL,
	"fixer_body" text,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggested_merge_entry_id" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_key" text,
	"decided_by_id" text,
	"decided_at" timestamp with time zone,
	"applied_entry_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lore_pending_edits" (
	"id" serial PRIMARY KEY NOT NULL,
	"lore_entry_id" integer,
	"kind" text DEFAULT 'edit' NOT NULL,
	"submitted_by" text NOT NULL,
	"proposed_diff" jsonb NOT NULL,
	"before_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"update_note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_id" text,
	"decided_at" timestamp with time zone,
	"decision_summary" text,
	"overridden_by" text,
	"applied_entry_id" integer,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"direction" text NOT NULL,
	"subject_id" text NOT NULL,
	"display_name" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"event_type" text,
	"source_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_actor_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"mission_id" integer,
	"event_id" integer,
	"mission_name" text,
	"event_type" text,
	"user_id" text NOT NULL,
	"user_name" text,
	"character_id" integer,
	"character_name" text,
	"fixer_id" text,
	"fixer_name" text,
	"mission_date" timestamp with time zone,
	"occurrence_start_at" timestamp with time zone,
	"amount" integer DEFAULT 0 NOT NULL,
	"payment_status" text DEFAULT 'paid' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"payment_error" text,
	"attendance_credited_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"mission_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"character_id" integer NOT NULL,
	"comment" text,
	"availability" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"mission_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"character_id" integer,
	"attendance_credited_at" timestamp with time zone,
	"payment_status" text DEFAULT 'unpaid' NOT NULL,
	"processing_at" timestamp with time zone,
	"pay_amount" integer,
	"payment_error" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"character_id" integer,
	"fixer_id" text,
	"title" text NOT NULL,
	"summary" text,
	"payout_eddies" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_npc_signups" (
	"id" serial PRIMARY KEY NOT NULL,
	"mission_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"character_id" integer,
	"state" text DEFAULT 'signed_up' NOT NULL,
	"pay_amount" integer,
	"payment_status" text DEFAULT 'unpaid' NOT NULL,
	"payment_error" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"tier" integer DEFAULT 1 NOT NULL,
	"player_pay" integer DEFAULT 0 NOT NULL,
	"npc_pay_amount" integer DEFAULT 0 NOT NULL,
	"location" text,
	"description" text,
	"image_url" text,
	"status" text DEFAULT 'open' NOT NULL,
	"workflow_state" text DEFAULT 'draft' NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"fixer_id" text,
	"start_at" timestamp with time zone,
	"npc_start_at" timestamp with time zone,
	"duration_minutes" integer DEFAULT 120 NOT NULL,
	"slots" integer DEFAULT 0 NOT NULL,
	"world_link" text,
	"job_type" text,
	"requested_skills" text,
	"client" text,
	"notes_for_players" text,
	"fixer_notes" text,
	"max_players" integer DEFAULT 0 NOT NULL,
	"discord_event_id" text,
	"discord_sync_error" text,
	"discord_thread_id" text,
	"discord_message_id" text,
	"discord_thread_snapshot_at" timestamp with time zone,
	"auto_pay_processed_at" timestamp with time zone,
	"npc_announced_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ncpd_arrest_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"character_id" integer NOT NULL,
	"officer_id" text,
	"officer_name" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"charges" text,
	"arrested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ncpd_case_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_by_id" text,
	"opened_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ncpd_character_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"character_id" integer NOT NULL,
	"author_id" text,
	"author_name" text,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ncpd_fines" (
	"id" serial PRIMARY KEY NOT NULL,
	"character_id" integer NOT NULL,
	"issued_by_id" text,
	"officer_name" text,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'unpaid' NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ncpd_laws" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"severity" text,
	"punishment" text,
	"restricted_notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ncpd_warrants" (
	"id" serial PRIMARY KEY NOT NULL,
	"character_id" integer NOT NULL,
	"issued_by_id" text,
	"issued_by_name" text,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"href" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pending_character_edits" (
	"id" serial PRIMARY KEY NOT NULL,
	"character_id" integer NOT NULL,
	"submitted_by" text NOT NULL,
	"proposed_diff" jsonb NOT NULL,
	"before_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"update_note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision_summary" text,
	"review_comment" text,
	"overridden_by" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"closed_outcome" text,
	"discord_message_id" text,
	"discord_thread_id" text
);
--> statement-breakpoint
CREATE TABLE "pending_edit_approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"edit_id" integer NOT NULL,
	"voter_id" text NOT NULL,
	"vote" text NOT NULL,
	"note" text,
	"voted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_role_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"alerted_at" timestamp with time zone,
	"granted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" integer NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_seen" (
	"user_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" integer NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_seen_user_id_subject_type_subject_id_pk" PRIMARY KEY("user_id","subject_type","subject_id")
);
--> statement-breakpoint
CREATE TABLE "review_votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" integer NOT NULL,
	"voter_id" text NOT NULL,
	"vote" text NOT NULL,
	"note" text,
	"voted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ripperdoc_employees" (
	"id" serial PRIMARY KEY NOT NULL,
	"ripperdoc_id" integer NOT NULL,
	"character_id" integer NOT NULL,
	"role" text DEFAULT 'doc' NOT NULL,
	"commission_pct" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ripperdoc_stock" (
	"id" serial PRIMARY KEY NOT NULL,
	"ripperdoc_id" integer NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"price" integer DEFAULT 0 NOT NULL,
	"cost" integer DEFAULT 0 NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "ripperdocs" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"owner_character_id" integer,
	"name" text NOT NULL,
	"purpose" text,
	"location" text,
	"housing_id" integer,
	"description" text,
	"banner_url" text,
	"balance" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_offers" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"offer_type" text DEFAULT 'sale' NOT NULL,
	"store_id" integer,
	"ripperdoc_id" integer,
	"stock_id" integer,
	"cwp" integer,
	"removed_item_id" integer,
	"remove_destination" text,
	"install_item_id" integer,
	"item_name" text NOT NULL,
	"item_category" text,
	"unit_price" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"total_price" integer NOT NULL,
	"cost_basis" integer,
	"buyer_character_id" integer NOT NULL,
	"buyer_user_id" text NOT NULL,
	"seller_character_id" integer,
	"seller_employee_id" integer,
	"commission_pct" integer DEFAULT 0 NOT NULL,
	"commission_amount" integer,
	"commission_settled_at" timestamp with time zone,
	"shift_wages_amount" integer,
	"shift_wages_settled_at" timestamp with time zone,
	"shift_wage_shift_ids" jsonb,
	"created_by_id" text NOT NULL,
	"memo" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"sid" text PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp (6) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_opens" (
	"id" serial PRIMARY KEY NOT NULL,
	"character_id" integer NOT NULL,
	"listing_id" integer,
	"opened_on" date NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "site_activity_daily" (
	"day" date NOT NULL,
	"user_id" text NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"logins" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "site_activity_daily_day_user_id_pk" PRIMARY KEY("day","user_id")
);
--> statement-breakpoint
CREATE TABLE "store_employees" (
	"id" serial PRIMARY KEY NOT NULL,
	"store_id" integer NOT NULL,
	"character_id" integer NOT NULL,
	"role" text DEFAULT 'clerk' NOT NULL,
	"commission_pct" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_shifts" (
	"id" serial PRIMARY KEY NOT NULL,
	"store_id" integer NOT NULL,
	"character_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"clock_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_end_at" timestamp with time zone NOT NULL,
	"clock_out_at" timestamp with time zone,
	"earned_total" integer DEFAULT 0 NOT NULL,
	"sales_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_stock" (
	"id" serial PRIMARY KEY NOT NULL,
	"store_id" integer NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"price" integer DEFAULT 0 NOT NULL,
	"cost" integer DEFAULT 0 NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"description" text,
	"power_level" text,
	"cyberware_req" text
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"owner_character_id" integer,
	"name" text NOT NULL,
	"kind" text DEFAULT 'mixed' NOT NULL,
	"purpose" text,
	"location" text,
	"housing_id" integer,
	"description" text,
	"banner_url" text,
	"balance" integer DEFAULT 0 NOT NULL,
	"shifts_enabled" boolean DEFAULT false NOT NULL,
	"shift_wage_pct" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trauma_team_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"character_id" integer NOT NULL,
	"tier" text NOT NULL,
	"reason" text,
	"cost_eddies" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ub_push_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"discord_id" text NOT NULL,
	"amount" integer NOT NULL,
	"reason" text,
	"ledger_id" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"pushed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"discord_id" text NOT NULL,
	"username" text NOT NULL,
	"global_name" text,
	"avatar_url" text,
	"roles" text[] DEFAULT '{}' NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now(),
	"roles_synced_at" timestamp with time zone,
	"verified18" boolean DEFAULT false NOT NULL,
	"login_count" integer DEFAULT 0 NOT NULL,
	"onboarding_banner_dismissed" boolean DEFAULT false NOT NULL,
	"notification_prompt_dismissed" boolean DEFAULT false NOT NULL,
	"rules_accepted" boolean DEFAULT false NOT NULL,
	"in_guild" boolean DEFAULT true NOT NULL,
	"guild_left_at" timestamp with time zone,
	"cyberpsycho_access" boolean DEFAULT false NOT NULL,
	"text_scale" text,
	"wallet_balance" integer DEFAULT 0 NOT NULL,
	"last_synced_ub_balance" integer,
	"last_synced_ub_cash" integer,
	"last_synced_ub_bank" integer,
	"last_synced_at" timestamp with time zone,
	"last_sync_status" text,
	"last_sync_error" text,
	"default_availability" jsonb,
	"availability_timezone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vrchat_agent_commands" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error" text,
	"created_by_id" text,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vrchat_agents" (
	"user_id" text PRIMARY KEY NOT NULL,
	"token_hash" text,
	"token_issued_at" timestamp with time zone,
	"label" text,
	"last_seen_at" timestamp with time zone,
	"status" jsonb,
	"status_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vrchat_instance_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"user_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vrchat_instance_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"location" text NOT NULL,
	"world_id" text NOT NULL,
	"world_name" text NOT NULL,
	"access_type" text DEFAULT 'unknown' NOT NULL,
	"region" text,
	"source" text DEFAULT 'live' NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"peak_user_count" integer DEFAULT 0 NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"sum_user_counts" integer DEFAULT 0 NOT NULL,
	"capacity" integer,
	"unique_users" integer
);
--> statement-breakpoint
CREATE TABLE "vrchat_instance_visits" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"vrchat_user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"duration_ms" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vrchat_instances" (
	"location" text PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"world_name" text NOT NULL,
	"thumbnail_url" text,
	"instance_short_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"access_type" text DEFAULT 'unknown' NOT NULL,
	"region" text,
	"user_count" integer DEFAULT 0 NOT NULL,
	"capacity" integer,
	"role_ids" jsonb,
	"role_names" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "vrchat_links" (
	"discord_id" text PRIMARY KEY NOT NULL,
	"discord_username" text NOT NULL,
	"discord_global_name" text,
	"vrchat_user_id" text NOT NULL,
	"vrchat_username" text NOT NULL,
	"vrchat_url" text NOT NULL,
	"source_message_id" text,
	"source_posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vrchat_sessions" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"auth_cookie" text,
	"two_factor_cookie" text,
	"pending_auth_cookie" text,
	"vrchat_user_id" text,
	"vrchat_display_name" text,
	"last_auth_at" timestamp with time zone,
	"last_error" text,
	"disconnected_since" timestamp with time zone,
	"last_disconnect_notify_at" timestamp with time zone,
	"last_auto_reconnect_at" timestamp with time zone,
	"last_poll_tick_at" timestamp with time zone,
	"poll_owner" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"character_id" integer,
	"user_id" text,
	"counterparty_character_id" integer,
	"counterparty_name" text,
	"amount" integer NOT NULL,
	"kind" text NOT NULL,
	"memo" text,
	"category" text,
	"source" text DEFAULT 'website' NOT NULL,
	"sync_status" text DEFAULT 'synced' NOT NULL,
	"idempotency_key" text,
	"related_entity_type" text,
	"related_entity_id" integer,
	"previous_balance" integer,
	"new_balance" integer,
	"error_message" text,
	"store_id" integer,
	"ripperdoc_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wholesaler_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"tier" text DEFAULT 'store' NOT NULL,
	"wholesale_price" integer DEFAULT 0 NOT NULL,
	"suggested_retail_price" integer,
	"cap" integer,
	"notes" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wholesaler_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"wholesaler_item_id" integer NOT NULL,
	"fixer_id" text NOT NULL,
	"store_id" integer,
	"ripperdoc_id" integer,
	"quantity" integer NOT NULL,
	"unit_wholesale_price" integer NOT NULL,
	"total_cost" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_claims" ADD CONSTRAINT "attendance_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_practice_clears" ADD CONSTRAINT "breach_practice_clears_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_practice_stats" ADD CONSTRAINT "breach_practice_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_puzzles" ADD CONSTRAINT "breach_puzzles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_puzzles" ADD CONSTRAINT "breach_puzzles_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_puzzles" ADD CONSTRAINT "breach_puzzles_assigned_character_id_characters_id_fk" FOREIGN KEY ("assigned_character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_puzzles" ADD CONSTRAINT "breach_puzzles_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_districts" ADD CONSTRAINT "catalog_districts_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_sheets" ADD CONSTRAINT "character_sheets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_sheets" ADD CONSTRAINT "character_sheets_overridden_by_users_id_fk" FOREIGN KEY ("overridden_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_sheets" ADD CONSTRAINT "character_sheets_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_status" ADD CONSTRAINT "character_status_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_tag_options" ADD CONSTRAINT "character_tag_options_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_updates" ADD CONSTRAINT "character_updates_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_updates" ADD CONSTRAINT "character_updates_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_week_snapshots" ADD CONSTRAINT "character_week_snapshots_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_requests" ADD CONSTRAINT "custom_requests_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_requests" ADD CONSTRAINT "custom_requests_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_requests" ADD CONSTRAINT "custom_requests_reserved_listing_id_catalog_rent_id_fk" FOREIGN KEY ("reserved_listing_id") REFERENCES "public"."catalog_rent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_requests" ADD CONSTRAINT "custom_requests_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_requests" ADD CONSTRAINT "custom_requests_overridden_by_users_id_fk" FOREIGN KEY ("overridden_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_requests" ADD CONSTRAINT "custom_requests_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dice_rolls" ADD CONSTRAINT "dice_rolls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_checkin_staff" ADD CONSTRAINT "event_checkin_staff_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_checkin_staff" ADD CONSTRAINT "event_checkin_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_checkin_staff" ADD CONSTRAINT "event_checkin_staff_added_by_id_users_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_npc_signups" ADD CONSTRAINT "event_npc_signups_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_npc_signups" ADD CONSTRAINT "event_npc_signups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_npc_signups" ADD CONSTRAINT "event_npc_signups_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_ticket_types" ADD CONSTRAINT "event_ticket_types_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tickets" ADD CONSTRAINT "event_tickets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tickets" ADD CONSTRAINT "event_tickets_ticket_type_id_event_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "public"."event_ticket_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tickets" ADD CONSTRAINT "event_tickets_buyer_user_id_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tickets" ADD CONSTRAINT "event_tickets_attended_by_id_users_id_fk" FOREIGN KEY ("attended_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tickets" ADD CONSTRAINT "event_tickets_refunded_by_id_users_id_fk" FOREIGN KEY ("refunded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_ticket_runner_user_id_users_id_fk" FOREIGN KEY ("ticket_runner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixer_npcs" ADD CONSTRAINT "fixer_npcs_fixer_id_users_id_fk" FOREIGN KEY ("fixer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidebook_pages" ADD CONSTRAINT "guidebook_pages_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidebook_pages" ADD CONSTRAINT "guidebook_pages_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidebook_pending_edits" ADD CONSTRAINT "guidebook_pending_edits_page_id_guidebook_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."guidebook_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidebook_pending_edits" ADD CONSTRAINT "guidebook_pending_edits_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidebook_pending_edits" ADD CONSTRAINT "guidebook_pending_edits_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housing" ADD CONSTRAINT "housing_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housing_requests" ADD CONSTRAINT "housing_requests_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housing_requests" ADD CONSTRAINT "housing_requests_listing_id_catalog_rent_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."catalog_rent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housing_requests" ADD CONSTRAINT "housing_requests_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housing_requests" ADD CONSTRAINT "housing_requests_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_command_uses" ADD CONSTRAINT "income_command_uses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lore_entries" ADD CONSTRAINT "lore_entries_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lore_entries" ADD CONSTRAINT "lore_entries_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lore_import_drafts" ADD CONSTRAINT "lore_import_drafts_suggested_merge_entry_id_lore_entries_id_fk" FOREIGN KEY ("suggested_merge_entry_id") REFERENCES "public"."lore_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lore_import_drafts" ADD CONSTRAINT "lore_import_drafts_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lore_pending_edits" ADD CONSTRAINT "lore_pending_edits_lore_entry_id_lore_entries_id_fk" FOREIGN KEY ("lore_entry_id") REFERENCES "public"."lore_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lore_pending_edits" ADD CONSTRAINT "lore_pending_edits_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lore_pending_edits" ADD CONSTRAINT "lore_pending_edits_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lore_pending_edits" ADD CONSTRAINT "lore_pending_edits_overridden_by_users_id_fk" FOREIGN KEY ("overridden_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lore_pending_edits" ADD CONSTRAINT "lore_pending_edits_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_actor_payments" ADD CONSTRAINT "mission_actor_payments_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_actor_payments" ADD CONSTRAINT "mission_actor_payments_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_actor_payments" ADD CONSTRAINT "mission_actor_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_applications" ADD CONSTRAINT "mission_applications_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_applications" ADD CONSTRAINT "mission_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_applications" ADD CONSTRAINT "mission_applications_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_applications" ADD CONSTRAINT "mission_applications_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_assignments" ADD CONSTRAINT "mission_assignments_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_assignments" ADD CONSTRAINT "mission_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_assignments" ADD CONSTRAINT "mission_assignments_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_log" ADD CONSTRAINT "mission_log_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_log" ADD CONSTRAINT "mission_log_fixer_id_users_id_fk" FOREIGN KEY ("fixer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_npc_signups" ADD CONSTRAINT "mission_npc_signups_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_npc_signups" ADD CONSTRAINT "mission_npc_signups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_npc_signups" ADD CONSTRAINT "mission_npc_signups_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_fixer_id_users_id_fk" FOREIGN KEY ("fixer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ncpd_arrest_reports" ADD CONSTRAINT "ncpd_arrest_reports_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ncpd_arrest_reports" ADD CONSTRAINT "ncpd_arrest_reports_officer_id_users_id_fk" FOREIGN KEY ("officer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ncpd_case_files" ADD CONSTRAINT "ncpd_case_files_opened_by_id_users_id_fk" FOREIGN KEY ("opened_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ncpd_character_notes" ADD CONSTRAINT "ncpd_character_notes_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ncpd_character_notes" ADD CONSTRAINT "ncpd_character_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ncpd_fines" ADD CONSTRAINT "ncpd_fines_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ncpd_fines" ADD CONSTRAINT "ncpd_fines_issued_by_id_users_id_fk" FOREIGN KEY ("issued_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ncpd_fines" ADD CONSTRAINT "ncpd_fines_paid_by_user_id_users_id_fk" FOREIGN KEY ("paid_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ncpd_laws" ADD CONSTRAINT "ncpd_laws_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ncpd_warrants" ADD CONSTRAINT "ncpd_warrants_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ncpd_warrants" ADD CONSTRAINT "ncpd_warrants_issued_by_id_users_id_fk" FOREIGN KEY ("issued_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_character_edits" ADD CONSTRAINT "pending_character_edits_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_character_edits" ADD CONSTRAINT "pending_character_edits_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_character_edits" ADD CONSTRAINT "pending_character_edits_overridden_by_users_id_fk" FOREIGN KEY ("overridden_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_character_edits" ADD CONSTRAINT "pending_character_edits_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_edit_approvals" ADD CONSTRAINT "pending_edit_approvals_edit_id_pending_character_edits_id_fk" FOREIGN KEY ("edit_id") REFERENCES "public"."pending_character_edits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_edit_approvals" ADD CONSTRAINT "pending_edit_approvals_voter_id_users_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_seen" ADD CONSTRAINT "review_seen_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_voter_id_users_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ripperdoc_employees" ADD CONSTRAINT "ripperdoc_employees_ripperdoc_id_ripperdocs_id_fk" FOREIGN KEY ("ripperdoc_id") REFERENCES "public"."ripperdocs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ripperdoc_employees" ADD CONSTRAINT "ripperdoc_employees_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ripperdoc_stock" ADD CONSTRAINT "ripperdoc_stock_ripperdoc_id_ripperdocs_id_fk" FOREIGN KEY ("ripperdoc_id") REFERENCES "public"."ripperdocs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ripperdocs" ADD CONSTRAINT "ripperdocs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ripperdocs" ADD CONSTRAINT "ripperdocs_housing_id_housing_id_fk" FOREIGN KEY ("housing_id") REFERENCES "public"."housing"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_offers" ADD CONSTRAINT "sale_offers_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_offers" ADD CONSTRAINT "sale_offers_ripperdoc_id_ripperdocs_id_fk" FOREIGN KEY ("ripperdoc_id") REFERENCES "public"."ripperdocs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_offers" ADD CONSTRAINT "sale_offers_buyer_character_id_characters_id_fk" FOREIGN KEY ("buyer_character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_offers" ADD CONSTRAINT "sale_offers_buyer_user_id_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_offers" ADD CONSTRAINT "sale_offers_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_opens" ADD CONSTRAINT "shop_opens_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_activity_daily" ADD CONSTRAINT "site_activity_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_employees" ADD CONSTRAINT "store_employees_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_employees" ADD CONSTRAINT "store_employees_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_shifts" ADD CONSTRAINT "store_shifts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_shifts" ADD CONSTRAINT "store_shifts_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_shifts" ADD CONSTRAINT "store_shifts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_stock" ADD CONSTRAINT "store_stock_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_housing_id_housing_id_fk" FOREIGN KEY ("housing_id") REFERENCES "public"."housing"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trauma_team_calls" ADD CONSTRAINT "trauma_team_calls_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ub_push_outbox" ADD CONSTRAINT "ub_push_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vrchat_agent_commands" ADD CONSTRAINT "vrchat_agent_commands_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vrchat_agent_commands" ADD CONSTRAINT "vrchat_agent_commands_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vrchat_agents" ADD CONSTRAINT "vrchat_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vrchat_instance_samples" ADD CONSTRAINT "vrchat_instance_samples_session_id_vrchat_instance_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."vrchat_instance_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vrchat_instance_visits" ADD CONSTRAINT "vrchat_instance_visits_session_id_vrchat_instance_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."vrchat_instance_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_ripperdoc_id_ripperdocs_id_fk" FOREIGN KEY ("ripperdoc_id") REFERENCES "public"."ripperdocs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wholesaler_orders" ADD CONSTRAINT "wholesaler_orders_wholesaler_item_id_wholesaler_items_id_fk" FOREIGN KEY ("wholesaler_item_id") REFERENCES "public"."wholesaler_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wholesaler_orders" ADD CONSTRAINT "wholesaler_orders_fixer_id_users_id_fk" FOREIGN KEY ("fixer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wholesaler_orders" ADD CONSTRAINT "wholesaler_orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wholesaler_orders" ADD CONSTRAINT "wholesaler_orders_ripperdoc_id_ripperdocs_id_fk" FOREIGN KEY ("ripperdoc_id") REFERENCES "public"."ripperdocs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ae_created_idx" ON "activity_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_one_per_week_idx" ON "attendance_claims" USING btree ("user_id","week_start");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_category_idx" ON "audit_log" USING btree ("category");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "bot_actor_attendance_user_idx" ON "bot_actor_attendance" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bot_actor_attendance_acted_idx" ON "bot_actor_attendance" USING btree ("acted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_attendance_log_user_ts_idx" ON "bot_attendance_log" USING btree ("user_id","logged_at");--> statement-breakpoint
CREATE INDEX "bot_balance_history_user_idx" ON "bot_balance_history" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bot_balance_history_ts_idx" ON "bot_balance_history" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_business_open_user_ts_idx" ON "bot_business_open_log" USING btree ("user_id","opened_at");--> statement-breakpoint
CREATE INDEX "bot_business_open_user_idx" ON "bot_business_open_log" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_payment_labels_user_label_ts_idx" ON "bot_payment_labels" USING btree ("user_id","label","recorded_at");--> statement-breakpoint
CREATE INDEX "bot_player_inventory_owner_idx" ON "bot_player_inventory" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "bot_player_inventory_char_idx" ON "bot_player_inventory" USING btree ("character_name");--> statement-breakpoint
CREATE INDEX "bot_rent_payment_events_user_idx" ON "bot_rent_payment_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bot_rent_payment_events_ts_idx" ON "bot_rent_payment_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "bot_store_inventory_store_idx" ON "bot_store_inventory" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "bot_ticket_index_ts_idx" ON "bot_ticket_index" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "bpc_rank_idx" ON "breach_practice_clears" USING btree ("difficulty","clear_ms","created_at");--> statement-breakpoint
CREATE INDEX "bpc_user_idx" ON "breach_practice_clears" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "breach_puzzles_assigned_user_idx" ON "breach_puzzles" USING btree ("assigned_user_id");--> statement-breakpoint
CREATE INDEX "breach_puzzles_assigned_char_idx" ON "breach_puzzles" USING btree ("assigned_character_id");--> statement-breakpoint
CREATE INDEX "breach_puzzles_status_idx" ON "breach_puzzles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "breach_puzzles_created_by_idx" ON "breach_puzzles" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "cws_week_char_idx" ON "character_week_snapshots" USING btree ("week_start","character_id");--> statement-breakpoint
CREATE INDEX "cws_week_idx" ON "character_week_snapshots" USING btree ("week_start");--> statement-breakpoint
CREATE UNIQUE INDEX "characters_imported_thread_idx" ON "characters" USING btree ("imported_from_thread_id");--> statement-breakpoint
CREATE INDEX "custom_requests_status_idx" ON "custom_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "custom_requests_requester_idx" ON "custom_requests" USING btree ("requested_by_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_requests_reserved_listing_live_idx" ON "custom_requests" USING btree ("reserved_listing_id") WHERE reserved_listing_id IS NOT NULL AND status IN ('pending', 'approved');--> statement-breakpoint
CREATE UNIQUE INDEX "custom_requests_character_tag_live_idx" ON "custom_requests" USING btree ("character_id",lower(details ->> 'tag')) WHERE type = 'character_tag' AND status IN ('pending', 'changes_requested');--> statement-breakpoint
CREATE UNIQUE INDEX "event_checkin_staff_unq" ON "event_checkin_staff" USING btree ("event_id","user_id");--> statement-breakpoint
CREATE INDEX "event_checkin_staff_user_idx" ON "event_checkin_staff" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_npc_signups_active_occ_idx" ON "event_npc_signups" USING btree ("event_id","user_id","occurrence_start_at") WHERE state = 'signed_up' AND occurrence_start_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "event_npc_signups_active_null_occ_idx" ON "event_npc_signups" USING btree ("event_id","user_id") WHERE state = 'signed_up' AND occurrence_start_at IS NULL;--> statement-breakpoint
CREATE INDEX "event_npc_signups_event_idx" ON "event_npc_signups" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_npc_signups_user_idx" ON "event_npc_signups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "event_ticket_types_event_idx" ON "event_ticket_types" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_tickets_event_idx" ON "event_tickets" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_tickets_type_idx" ON "event_tickets" USING btree ("ticket_type_id");--> statement-breakpoint
CREATE INDEX "event_tickets_buyer_idx" ON "event_tickets" USING btree ("buyer_user_id");--> statement-breakpoint
CREATE INDEX "events_start_idx" ON "events" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX "events_status_idx" ON "events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "events_created_by_idx" ON "events" USING btree ("created_by_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_discord_event_id_unq" ON "events" USING btree ("discord_event_id") WHERE "events"."discord_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "guidebook_pages_slug_idx" ON "guidebook_pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "guidebook_pages_section_idx" ON "guidebook_pages" USING btree ("section");--> statement-breakpoint
CREATE UNIQUE INDEX "guidebook_pages_channel_idx" ON "guidebook_pages" USING btree ("discord_channel_id");--> statement-breakpoint
CREATE INDEX "guidebook_pending_edits_status_idx" ON "guidebook_pending_edits" USING btree ("status");--> statement-breakpoint
CREATE INDEX "guidebook_pending_edits_page_idx" ON "guidebook_pending_edits" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "inv_events_uuid_idx" ON "inventory_events" USING btree ("instance_uuid");--> statement-breakpoint
CREATE INDEX "inv_events_created_idx" ON "inventory_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lore_entries_slug_idx" ON "lore_entries" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "lore_entries_category_idx" ON "lore_entries" USING btree ("category");--> statement-breakpoint
CREATE INDEX "lore_entries_name_idx" ON "lore_entries" USING btree ("name");--> statement-breakpoint
CREATE INDEX "lore_import_drafts_status_idx" ON "lore_import_drafts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "lore_import_drafts_group_key_idx" ON "lore_import_drafts" USING btree ("group_key");--> statement-breakpoint
CREATE INDEX "lore_import_drafts_source_key_idx" ON "lore_import_drafts" USING btree ("source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "lore_import_drafts_pending_group_uq" ON "lore_import_drafts" USING btree ("group_key") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "lore_pending_edits_status_idx" ON "lore_pending_edits" USING btree ("status");--> statement-breakpoint
CREATE INDEX "lore_pending_edits_entry_idx" ON "lore_pending_edits" USING btree ("lore_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_events_ref_idx" ON "membership_events" USING btree ("source_ref");--> statement-breakpoint
CREATE INDEX "membership_events_src_time_idx" ON "membership_events" USING btree ("source","occurred_at");--> statement-breakpoint
CREATE INDEX "membership_events_subject_idx" ON "membership_events" USING btree ("subject_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_actor_paid_unique_idx" ON "mission_actor_payments" USING btree ("mission_id","user_id") WHERE payment_status = 'paid';--> statement-breakpoint
CREATE UNIQUE INDEX "mission_actor_event_paid_unique_idx" ON "mission_actor_payments" USING btree ("event_id","user_id") WHERE payment_status = 'paid' and event_id is not null and occurrence_start_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "mission_actor_event_occ_paid_unique_idx" ON "mission_actor_payments" USING btree ("event_id","user_id","occurrence_start_at") WHERE payment_status = 'paid' and event_id is not null and occurrence_start_at is not null;--> statement-breakpoint
CREATE INDEX "mission_actor_payments_mission_idx" ON "mission_actor_payments" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "mission_actor_payments_user_idx" ON "mission_actor_payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mission_actor_payments_fixer_idx" ON "mission_actor_payments" USING btree ("fixer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_applications_mission_character_idx" ON "mission_applications" USING btree ("mission_id","character_id");--> statement-breakpoint
CREATE INDEX "mission_applications_mission_idx" ON "mission_applications" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "mission_applications_user_idx" ON "mission_applications" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_assignments_mission_user_idx" ON "mission_assignments" USING btree ("mission_id","user_id");--> statement-breakpoint
CREATE INDEX "mission_assignments_mission_idx" ON "mission_assignments" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "mission_assignments_user_idx" ON "mission_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_npc_signups_active_idx" ON "mission_npc_signups" USING btree ("mission_id","user_id") WHERE state = 'signed_up';--> statement-breakpoint
CREATE INDEX "mission_npc_signups_mission_idx" ON "mission_npc_signups" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "mission_npc_signups_user_idx" ON "mission_npc_signups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "missions_status_idx" ON "missions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "missions_workflow_state_idx" ON "missions" USING btree ("workflow_state");--> statement-breakpoint
CREATE INDEX "missions_fixer_idx" ON "missions" USING btree ("fixer_id");--> statement-breakpoint
CREATE INDEX "missions_start_idx" ON "missions" USING btree ("start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "missions_discord_thread_idx" ON "missions" USING btree ("discord_thread_id") WHERE discord_thread_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ncpd_reports_char_idx" ON "ncpd_arrest_reports" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "ncpd_case_files_status_idx" ON "ncpd_case_files" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ncpd_notes_char_idx" ON "ncpd_character_notes" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "ncpd_fines_char_idx" ON "ncpd_fines" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "ncpd_fines_status_idx" ON "ncpd_fines" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ncpd_warrants_char_idx" ON "ncpd_warrants" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "ncpd_warrants_status_idx" ON "ncpd_warrants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_edit_one_per_char_idx" ON "pending_character_edits" USING btree ("character_id") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "pending_edit_vote_unique_idx" ON "pending_edit_approvals" USING btree ("edit_id","voter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_role_grants_pending_uq" ON "pending_role_grants" USING btree ("user_id","role_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "review_comment_subject_idx" ON "review_comments" USING btree ("subject_type","subject_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_vote_unique_idx" ON "review_votes" USING btree ("subject_type","subject_id","voter_id");--> statement-breakpoint
CREATE INDEX "review_vote_subject_idx" ON "review_votes" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "sale_offers_status_idx" ON "sale_offers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sale_offers_buyer_idx" ON "sale_offers" USING btree ("buyer_user_id");--> statement-breakpoint
CREATE INDEX "sale_offers_store_idx" ON "sale_offers" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "sale_offers_ripperdoc_idx" ON "sale_offers" USING btree ("ripperdoc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_opens_one_per_day_idx" ON "shop_opens" USING btree ("character_id","opened_on");--> statement-breakpoint
CREATE INDEX "shop_opens_char_month_idx" ON "shop_opens" USING btree ("character_id","opened_at");--> statement-breakpoint
CREATE INDEX "site_activity_daily_day_idx" ON "site_activity_daily" USING btree ("day");--> statement-breakpoint
CREATE UNIQUE INDEX "store_shifts_one_active_per_user_idx" ON "store_shifts" USING btree ("user_id") WHERE clock_out_at IS NULL;--> statement-breakpoint
CREATE INDEX "store_shifts_store_active_idx" ON "store_shifts" USING btree ("store_id","clock_out_at");--> statement-breakpoint
CREATE INDEX "store_shifts_store_start_idx" ON "store_shifts" USING btree ("store_id","clock_in_at");--> statement-breakpoint
CREATE INDEX "ub_outbox_status_idx" ON "ub_push_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "ub_outbox_user_idx" ON "ub_push_outbox" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_discord_id_idx" ON "users" USING btree ("discord_id");--> statement-breakpoint
CREATE INDEX "vrchat_cmd_queue_idx" ON "vrchat_agent_commands" USING btree ("user_id","status","id");--> statement-breakpoint
CREATE INDEX "visamp_session_idx" ON "vrchat_instance_samples" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vis_open_location_idx" ON "vrchat_instance_sessions" USING btree ("location") WHERE closed_at IS NULL AND source = 'live';--> statement-breakpoint
CREATE INDEX "vis_first_seen_idx" ON "vrchat_instance_sessions" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "viv_session_idx" ON "vrchat_instance_visits" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "viv_user_idx" ON "vrchat_instance_visits" USING btree ("vrchat_user_id");--> statement-breakpoint
CREATE INDEX "viv_name_idx" ON "vrchat_instance_visits" USING btree (lower("display_name"));--> statement-breakpoint
CREATE INDEX "viv_joined_idx" ON "vrchat_instance_visits" USING btree ("joined_at");--> statement-breakpoint
CREATE INDEX "wt_char_idx" ON "wallet_transactions" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "wt_user_idx" ON "wallet_transactions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wt_idem_idx" ON "wallet_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "wt_store_idx" ON "wallet_transactions" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "wt_ripperdoc_idx" ON "wallet_transactions" USING btree ("ripperdoc_id");--> statement-breakpoint
CREATE INDEX "wo_item_idx" ON "wholesaler_orders" USING btree ("wholesaler_item_id");