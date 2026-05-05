CREATE TABLE `channel_routing_state` (
	`channel_id` integer PRIMARY KEY NOT NULL,
	`success_alpha` real DEFAULT 2 NOT NULL,
	`success_beta` real DEFAULT 2 NOT NULL,
	`latency_log_mu` real DEFAULT 0 NOT NULL,
	`latency_log_sigma2` real DEFAULT 0.8 NOT NULL,
	`latency_n` integer DEFAULT 0 NOT NULL,
	`prompt_ewma` real DEFAULT 0 NOT NULL,
	`completion_ewma` real DEFAULT 0 NOT NULL,
	`cache_read_ewma` real DEFAULT 0 NOT NULL,
	`cache_creation_ewma` real DEFAULT 0 NOT NULL,
	`pricing_snapshot` text,
	`manual_weight` real DEFAULT 1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`channel_id`) REFERENCES `route_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `channel_routing_state_updated_at_idx` ON `channel_routing_state` (`updated_at`);