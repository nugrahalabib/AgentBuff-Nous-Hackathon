-- Step 5 — Billing + usage-poller schema migration
-- Generated 2026-04-19. Apply via `psql $DATABASE_URL -f scripts/migrations/0001_step5_billing.sql`
-- or run `pnpm db:push` to let drizzle-kit diff schema.ts and produce equivalent DDL.
--
-- Idempotent (every ADD COLUMN uses IF NOT EXISTS; every CREATE UNIQUE INDEX uses IF NOT EXISTS).
-- Safe to re-run after a partial failure.

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. user_container: add usage-poller cursor + throttle markers
-- ──────────────────────────────────────────────────────────────

ALTER TABLE user_container
  ADD COLUMN IF NOT EXISTS last_usage_cursor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_usage_polled_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS balance_throttled_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS stop_warned_at TIMESTAMP;

-- ──────────────────────────────────────────────────────────────
-- 2. transaction: retry state + idempotency guarantee
-- ──────────────────────────────────────────────────────────────

ALTER TABLE "transaction"
  ADD COLUMN IF NOT EXISTS sku TEXT,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_install_error TEXT,
  ADD COLUMN IF NOT EXISTS installed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

-- Pre-flight: refuse to create UNIQUE if any duplicates exist.
-- NULL values are distinct per SQL standard, so rows without a midtransOrderId are fine.
DO $$
DECLARE
  dup_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT midtrans_order_id FROM "transaction"
    WHERE midtrans_order_id IS NOT NULL
    GROUP BY midtrans_order_id
    HAVING COUNT(*) > 1
  ) t;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'transaction.midtrans_order_id has % duplicate values. Resolve before applying UNIQUE index.', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS transaction_midtrans_order_id_uq
  ON "transaction" (midtrans_order_id)
  WHERE midtrans_order_id IS NOT NULL;

-- ──────────────────────────────────────────────────────────────
-- 3. container_skill: version + transaction link + upsert uniqueness
-- ──────────────────────────────────────────────────────────────

ALTER TABLE container_skill
  ADD COLUMN IF NOT EXISTS version TEXT,
  ADD COLUMN IF NOT EXISTS transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

-- Add FK separately so it is idempotent (ADD CONSTRAINT IF NOT EXISTS is not standard).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'container_skill_transaction_id_fk'
  ) THEN
    ALTER TABLE container_skill
      ADD CONSTRAINT container_skill_transaction_id_fk
      FOREIGN KEY (transaction_id) REFERENCES "transaction" (id) ON DELETE SET NULL;
  END IF;
END $$;

-- De-dup existing rows before UNIQUE index creation (keep most recent per user+skill_key).
DELETE FROM container_skill a
USING container_skill b
WHERE a.user_id = b.user_id
  AND a.skill_key = b.skill_key
  AND a.installed_at < b.installed_at;

CREATE UNIQUE INDEX IF NOT EXISTS container_skill_user_skill_uq
  ON container_skill (user_id, skill_key);

-- ──────────────────────────────────────────────────────────────
-- 4. subscription: idempotency guarantee
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  dup_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT midtrans_order_id FROM subscription
    WHERE midtrans_order_id IS NOT NULL
    GROUP BY midtrans_order_id
    HAVING COUNT(*) > 1
  ) t;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'subscription.midtrans_order_id has % duplicate values. Resolve before applying UNIQUE index.', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS subscription_midtrans_order_id_uq
  ON subscription (midtrans_order_id)
  WHERE midtrans_order_id IS NOT NULL;

COMMIT;
