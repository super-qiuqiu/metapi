CREATE TABLE `model_hour_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bucket_start_utc` text NOT NULL,
	`site_id` integer NOT NULL,
	`model` text NOT NULL,
	`total_calls` integer DEFAULT 0 NOT NULL,
	`success_calls` integer DEFAULT 0 NOT NULL,
	`failed_calls` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`total_spend` real DEFAULT 0 NOT NULL,
	`total_latency_ms` integer DEFAULT 0 NOT NULL,
	`latency_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "model_hour_usage_non_negative" CHECK("model_hour_usage"."total_calls" >= 0 and "model_hour_usage"."success_calls" >= 0 and "model_hour_usage"."failed_calls" >= 0 and "model_hour_usage"."total_tokens" >= 0 and "model_hour_usage"."total_spend" >= 0 and "model_hour_usage"."total_latency_ms" >= 0 and "model_hour_usage"."latency_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_hour_usage_hour_site_model_unique` ON `model_hour_usage` (`bucket_start_utc`,`site_id`,`model`);
--> statement-breakpoint
CREATE INDEX `model_hour_usage_hour_idx` ON `model_hour_usage` (`bucket_start_utc`);
--> statement-breakpoint
CREATE INDEX `model_hour_usage_site_id_idx` ON `model_hour_usage` (`site_id`);
--> statement-breakpoint
CREATE INDEX `model_hour_usage_model_idx` ON `model_hour_usage` (`model`);
