-- Phase 1 of the persistent user memory feature: per-owner memory items.
-- Apply with: npx wrangler d1 execute personal-agent-db --local --file migrations/0001-user-memories.sql
-- The runtime schema ensure (ensureWidgetSchema in src/widget/db.ts) runs the same DDL on first
-- request, so fresh deployments need no manual step; it also adds the `memory_enabled` column to
-- `bots` for existing tables (SQLite has no ADD COLUMN IF NOT EXISTS, so that ALTER lives there
-- behind a duplicate-column catch instead of in this file).
CREATE TABLE IF NOT EXISTS user_memories (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'visitor')),
  owner_id TEXT NOT NULL,
  category TEXT DEFAULT 'context',
  content TEXT NOT NULL,
  source_session_id TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_memories_owner
  ON user_memories (bot_id, owner_type, owner_id, is_active);
