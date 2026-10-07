import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const games = sqliteTable('games', {
  id: text('id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  state: text('state').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const chatMessages = sqliteTable('chat_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: text('client_id').notNull(),
  requestId: text('request_id').notNull(),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [uniqueIndex('chat_messages_client_request_unique').on(table.clientId, table.requestId)]);
