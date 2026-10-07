ALTER TABLE `chat_messages` ADD `kind` text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `voice_id` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `nickname` text DEFAULT '' NOT NULL;