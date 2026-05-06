-- 1. 删除旧普通索引
DROP INDEX IF EXISTS `accounts_oauth_identity_idx`;--> statement-breakpoint
-- 2. 创建唯一索引（IF NOT EXISTS 防止重复创建）
CREATE UNIQUE INDEX IF NOT EXISTS `accounts_oauth_identity_unique` ON `accounts` (`oauth_provider`,`oauth_account_key`,`oauth_project_id`);
