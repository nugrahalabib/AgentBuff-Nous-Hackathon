import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  primaryKey,
  index,
  uniqueIndex,
  varchar,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AdapterAccountType } from "@auth/core/adapters";

// ──────────────────────────────────────────────
// NextAuth required tables
// ──────────────────────────────────────────────

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
  // Admin RBAC (admin-panel foundation F1). user (default) | support (read-only
  // admin) | admin (full). Authoritative role check reads this column directly
  // (src/lib/admin/rbac.ts) so a granted/revoked role takes effect immediately.
  role: varchar("role", { length: 10 }).default("user").notNull(),
  // Admin moderation (D1 finisher). When true, the /app gate blocks access and
  // the user's container is docker-stopped. Authoritative server-side check —
  // read in src/app/app/layout.tsx so a suspension takes effect on next load.
  suspended: boolean("suspended").default(false).notNull(),
  suspendedReason: text("suspended_reason"),
  suspendedAt: timestamp("suspended_at"),
  // Admin grace-delete (D1). When set, the account is scheduled for hard deletion
  // at this time: the /app gate blocks access during the grace window (recovery
  // possible until then), and a cleanup worker hard-deletes once it passes. Null =
  // not scheduled. Cancelling clears both columns.
  deletionScheduledAt: timestamp("deletion_scheduled_at"),
  deletionReason: text("deletion_reason"),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => ({
    compositePk: primaryKey({
      columns: [account.provider, account.providerAccountId],
    }),
  }),
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => ({
    compositePk: primaryKey({
      columns: [vt.identifier, vt.token],
    }),
  }),
);

// ──────────────────────────────────────────────
// Application tables
// ──────────────────────────────────────────────

export const userProfiles = pgTable("user_profile", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" })
    .unique(),
  displayName: text("display_name"),
  nickname: text("nickname"),
  avatarEmoji: text("avatar_emoji"),
  locale: varchar("locale", { length: 5 }).default("id"),
  onboarded: boolean("onboarded").default(false),
  // Resume cursor for the multi-step onboarding flow. 0 = not started; advances
  // per completed step; terminal value mirrors `onboarded=true`. Lets a user who
  // drops off mid-onboarding resume from their last step on re-login.
  onboardingStep: integer("onboarding_step").default(0).notNull(),
  // Snapshot of partial answers collected so far, to pre-fill steps on resume.
  onboardingAnswers: jsonb("onboarding_answers").$type<Record<string, unknown>>(),
  // Per-user IANA timezone (Chief #1 mandate). Captured at onboarding, plumbed to
  // the container as HERMES_TIMEZONE at provision. Null falls back to the global
  // hermesConfig.timezone default.
  timezone: text("timezone"),
  city: text("city"),
  country: text("country"),
  // Widened 20->40 to stop silent truncation of focus-goal ids.
  focus: varchar("focus", { length: 40 }),
  whatsapp: text("whatsapp"),
  dob: text("dob"),
  role: text("role"),
  industryIds: text("industry_ids"),
  interestIds: text("interest_ids"),
  // ── Marketing / segmentation fields (honest framing, no fake promises) ──
  businessName: text("business_name"),
  jurusan: text("jurusan"),
  teamSize: varchar("team_size", { length: 20 }),
  // Attribution: how the user heard about AgentBuff (TikTok/IG/WA/teman/etc).
  referralSource: varchar("referral_source", { length: 40 }),
  // Activation marker (F2 funnel "first-chat"). Set once, atomically, the first
  // time the user sends a chat through the WS proxy; the null->now() flip is what
  // gates the one-time trackEvent("first_chat") so reconnects/restarts don't
  // double-count.
  firstChatAt: timestamp("first_chat_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const userContainers = pgTable("user_container", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" })
    .unique(),
  containerId: text("container_id"),
  containerName: text("container_name").notNull(),
  port: integer("port").notNull().unique(),
  // Bridge auth token (>=32 byte random per container). Consumed by
  // docker/hermes-bridge/auth.py on the `connect` frame. Historically named
  // gateway_token from the OpenClaw era; kept as-is so existing DB rows
  // don't need a column rename. New containers populate this with a freshly
  // rotated secret per provision.
  gatewayToken: text("gateway_token").notNull(),
  // State machine: queued | starting | awaiting-health | running | failed | destroyed | stopped
  status: varchar("status", { length: 24 }).default("queued").notNull(),
  errorMessage: text("error_message"),
  imageVersion: text("image_version"),
  provisionAttempts: integer("provision_attempts").default(0).notNull(),
  lastHealthAt: timestamp("last_health_at"),
  // Step 5d — usage-poller cursor. Highest `sessions.usage` result.totals.tokens.total seen.
  // BIGINT mode:"number" = safe up to 2^53 (>>> any realistic token total).
  lastUsageCursor: bigint("last_usage_cursor", { mode: "number" }).default(0).notNull(),
  lastUsagePolledAt: timestamp("last_usage_polled_at"),
  // Non-null while the container is docker-stopped due to balance<=0.
  balanceThrottledAt: timestamp("balance_throttled_at"),
  // Non-null while we are inside the 10s grace warning window before docker stop.
  stopWarnedAt: timestamp("stop_warned_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Port pool: pre-seeded rows, one per allowed host port.
// Allocation uses SELECT ... FOR UPDATE SKIP LOCKED to serialize under concurrency.
export const containerPortSlots = pgTable("container_port_slot", {
  port: integer("port").primaryKey(),
  userId: text("user_id")
    .references(() => users.id, { onDelete: "set null" })
    .unique(),
  claimedAt: timestamp("claimed_at"),
});

// ──────────────────────────────────────────────
// Phase B: Core product tables
// ──────────────────────────────────────────────

export const userAgents = pgTable("user_agent", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role"),
  icon: text("icon"),
  color: text("color"),
  status: varchar("status", { length: 20 }).default("active").notNull(),
  source: varchar("source", { length: 20 }).default("official").notNull(),
  sourceItemId: text("source_item_id"),
  customInstructions: text("custom_instructions"),
  channels: jsonb("channels").$type<string[]>().default([]),
  tasksCompleted: integer("tasks_completed").default(0).notNull(),
  energyUsed: integer("energy_used").default(0).notNull(),
  // ── Authoritative agent spec (Postgres = source of truth) for re-hydration ──
  // On container provision/rebuild these drive a fresh agents.create RPC so the
  // user never loses an agent they configured. Mirrors reinstallSkillsForUser.
  // Which of the 8 Skill Tree archetypes this agent was forged from.
  archetype: varchar("archetype", { length: 40 }),
  emoji: text("emoji"),
  // Communication tone preset: casual | professional | smart.
  tone: varchar("tone", { length: 20 }),
  description: text("description"),
  // Full generated SOUL.md persona text — re-applied via agents.files.set.
  soulContent: text("soul_content"),
  // Engine-assigned profile id returned by agents.create (NOT our UUID).
  engineAgentId: text("engine_agent_id"),
  modelPrimary: text("model_primary"),
  modelProvider: varchar("model_provider", { length: 30 }),
  modelFallbacks: jsonb("model_fallbacks").$type<{ provider: string; model: string }[]>(),
  // Per-agent skill allowlist (engine inverts to skills.disabled).
  skills: jsonb("skills").$type<string[]>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const containerSkills = pgTable(
  "container_skill",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => userAgents.id, { onDelete: "set null" }),
    skillKey: text("skill_key").notNull(),
    source: varchar("source", { length: 20 }).default("bundled").notNull(),
    marketplaceItemId: text("marketplace_item_id"),
    enabled: boolean("enabled").default(true).notNull(),
    // Version tag from ClawHub manifest at install time. Surfaced by self-healing reinstall.
    version: text("version"),
    // Links the install row back to the transaction that paid for it.
    // Nullable because bundled/legacy rows may predate this column.
    transactionId: text("transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    installedAt: timestamp("installed_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // One skill per user — repeat purchases upsert (UPDATE transactionId + version), never duplicate.
    uniqueIndex("container_skill_user_skill_uq").on(table.userId, table.skillKey),
  ],
);

export const apiKeys = pgTable("api_key", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Holds the engine env-var name the key maps to (e.g. GEMINI_API_KEY).
  // Widened 20->64 so longer provider env keys fit (env-var-key design).
  providerId: varchar("provider_id", { length: 64 }).notNull(),
  keyEncrypted: text("key_encrypted").notNull(),
  keyMasked: text("key_masked").notNull(),
  status: varchar("status", { length: 20 }).default("connected").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const userEnergy = pgTable("user_energy", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // Default 0 — energy is gated OFF (BYOK). A non-zero seed would surface as a
  // phantom balance the moment the gate flips on. Real caps are written at
  // settlement (activateSubscription) / top-up only.
  balance: integer("balance").default(0).notNull(),
  maxBalance: integer("max_balance").default(0).notNull(),
  lastTopupAt: timestamp("last_topup_at"),
});

export const engineConfig = pgTable("engine_config", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  mode: varchar("mode", { length: 20 }).default("autopilot").notNull(),
  providerId: varchar("provider_id", { length: 20 }),
});

export const notifications = pgTable("notification", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tab: varchar("tab", { length: 20 }).notNull(),
  icon: text("icon"),
  text: text("text").notNull(),
  highPriority: boolean("high_priority").default(false).notNull(),
  read: boolean("read").default(false).notNull(),
  actionLabel: text("action_label"),
  actionHref: text("action_href"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const notifPrefs = pgTable("notif_pref", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  aiTasks: boolean("ai_tasks").default(true).notNull(),
  system: boolean("system").default(true).notNull(),
  store: boolean("store").default(true).notNull(),
  lowEnergy: boolean("low_energy").default(true).notNull(),
  waEnabled: boolean("wa_enabled").default(false).notNull(),
});

// ──────────────────────────────────────────────
// Phase C: Monetization tables
// ──────────────────────────────────────────────

export const subscriptions = pgTable(
  "subscription",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tier: varchar("tier", { length: 20 }).notNull(),
    billingCycle: varchar("billing_cycle", { length: 10 }).notNull(),
    priceRp: integer("price_rp").notNull(),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    startsAt: timestamp("starts_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    autoRenew: boolean("auto_renew").default(false).notNull(),
    // Lowest H-N renewal reminder already sent (3,2,1) so the renewal worker
    // doesn't re-send the same countdown each tick. Null = none sent yet.
    lastRenewalRemindedDaysLeft: integer("last_renewal_reminded_days_left"),
    frozenPriceRp: integer("frozen_price_rp"),
    midtransOrderId: text("midtrans_order_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // At most one subscription row per non-null orderId — stops a duplicate
    // INSERT (the first-ever-subscribe path) from creating two rows for the same
    // order. Does NOT guard renewal webhook replay: settle.ts UPDATES the
    // existing row in place (and overwrites this column with the newest order),
    // so renewal idempotency is owned entirely by the transactions table's
    // pending->completed flip; historical payment<->sub correlation must use the
    // transactions table, not this column. PARTIAL (IS NOT NULL) — trial/legacy
    // rows carry no orderId and must not collide on NULL.
    uniqueIndex("subscription_midtrans_order_id_uq")
      .on(table.midtransOrderId)
      .where(sql`${table.midtransOrderId} IS NOT NULL`),
    // The one-active-row-per-user invariant, enforced at the DB level. settle.ts
    // maintains it (update-in-place, never a 2nd active row); this index makes
    // any out-of-band INSERT (admin scripts, future code) fail loudly instead of
    // silently orphaning a user's paid time.
    uniqueIndex("subscription_user_active_uq")
      .on(table.userId)
      .where(sql`${table.status} = 'active'`),
    // Per-user reads on every dashboard render; createdAt DESC serves the
    // resolver's most-recent-row lookup.
    index("subscription_user_created_idx").on(table.userId, table.createdAt),
  ],
);

// 14-day free trial of the HOSTED service (BYOK — we never bill tokens).
// Distinct from `subscription` (which carries a midtrans_order_id + price); a
// trial has neither. Seeded at onboarding completion (when the container is
// provisioned), expires 14 days later. Status drives the /app hard gate: when
// status='expired' and there is no active subscription, every /app tab locks
// except billing and a payment popup is shown. Renewal is manual (reminders at
// H-3/H-2/H-1); there is no auto-renew.
export const userTrials = pgTable("user_trial", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endsAt: timestamp("ends_at").notNull(),
  // active | expired | converted
  status: varchar("status", { length: 20 }).default("active").notNull(),
  convertedAt: timestamp("converted_at"),
  // Lowest H-N reminder already sent (3, 2, 1) so the lifecycle worker doesn't
  // re-send the same countdown reminder every tick. Null = none sent yet.
  lastRemindedDaysLeft: integer("last_reminded_days_left"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// One-time-trial ledger, keyed by a hash of the user's email. Deliberately NOT
// FK'd to users: it must SURVIVE account deletion so a deleted-then-re-registered
// email cannot farm a fresh 14-day trial. A row is written the first time a trial
// is granted; onboarding-complete then grants an already-expired trial when this
// ledger has the email but the current account has no trial row (a re-registrant).
export const trialGrants = pgTable("trial_grant", {
  emailHash: text("email_hash").primaryKey(),
  grantedAt: timestamp("granted_at").defaultNow().notNull(),
});

export const transactions = pgTable(
  "transaction",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // type: "topup" | "subscription" | "skill-install"
    type: varchar("type", { length: 20 }).notNull(),
    description: text("description").notNull(),
    amountRp: integer("amount_rp").notNull(),
    energyDelta: integer("energy_delta").default(0).notNull(),
    // status: "pending" | "completed" | "installed" | "install_failed" | "failed" | "refunded"
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    paymentRef: text("payment_ref"),
    // Midtrans payment_type captured at settlement (e.g. "qris", "gopay",
    // "credit_card", "bank_transfer:bca") — the "paid via what" on the receipt +
    // history so every payment is verifiable. Null until settled.
    paymentMethod: text("payment_method"),
    // Authoritative, immutable payment timestamp (the moment we settled it).
    // Distinct from updatedAt (which can drift on later writes) — drives the
    // receipt date so the struk always shows WHEN the money actually landed.
    paidAt: timestamp("paid_at"),
    midtransOrderId: text("midtrans_order_id"),
    // For type="skill-install": ClawHub slug to install after payment settles.
    sku: text("sku"),
    // Retry state for skill install after a paid but gateway-unreachable webhook.
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextRetryAt: timestamp("next_retry_at"),
    lastInstallError: text("last_install_error"),
    installedAt: timestamp("installed_at"),
    // Set when an admin force-uninstalls this skill (D4 moderation). Excludes the
    // row from reinstallSkillsForUser() self-heal so a reprovision does NOT
    // resurrect a skill an admin pulled. Null = normal (eligible for reinstall).
    adminUninstalledAt: timestamp("admin_uninstalled_at"),
    // Free-text reason an admin gave when refunding (D2). Durable, queryable paper
    // trail beyond the audit log. Null unless this row was admin-refunded.
    refundReason: text("refund_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Hard idempotency barrier: Midtrans may redeliver webhooks after network flaps.
    // UNIQUE guarantees a replay cannot create a second row with the same orderId.
    // PARTIAL (IS NOT NULL) to match the migration SQL exactly (non-Midtrans rows
    // carry no orderId and must not collide on NULL).
    uniqueIndex("transaction_midtrans_order_id_uq")
      .on(table.midtransOrderId)
      .where(sql`${table.midtransOrderId} IS NOT NULL`),
    // Per-user transaction history reads (billing dashboard).
    index("transaction_user_id_idx").on(table.userId),
  ],
);

export const paymentMethods = pgTable("payment_method", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 20 }).notNull(),
  brand: varchar("brand", { length: 30 }).notNull(),
  lastFour: varchar("last_four", { length: 4 }),
  expiry: varchar("expiry", { length: 5 }),
  isDefault: boolean("is_default").default(false).notNull(),
  gatewayToken: text("gateway_token"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const energyBundles = pgTable("energy_bundle", {
  id: varchar("id", { length: 20 }).primaryKey(),
  name: text("name").notNull(),
  energy: integer("energy").notNull(),
  bonusEnergy: integer("bonus_energy").default(0).notNull(),
  priceRp: integer("price_rp").notNull(),
  active: boolean("active").default(true).notNull(),
});

// ──────────────────────────────────────────────
// Marketing / lead capture
// ──────────────────────────────────────────────

// Early-access waitlist for tiers that aren't purchasable yet (Full Managed).
// The public landing pricing form writes here; the Admin page (phase 5) reads
// it as a lead list. No auth — anyone can register interest. Source of truth
// for "who wants the managed plan" so we can reach out at launch.
export const earlyAccessLeads = pgTable("early_access_lead", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  email: text("email").notNull(),
  whatsapp: text("whatsapp"),
  note: text("note"),
  // Which offering they want early access to. Default "full-managed".
  tier: varchar("tier", { length: 30 }).default("full-managed").notNull(),
  // Where the lead came from, for admin segmentation later.
  source: varchar("source", { length: 40 }).default("landing-pricing").notNull(),
  // Attribution (D10): utm_source/medium/campaign/term/content captured from the
  // landing URL at submit. Null when the visitor arrived with no UTM params.
  utm: jsonb("utm").$type<Record<string, string>>(),
  // Lead lifecycle for admin triage: new | contacted | converted | archived.
  status: varchar("status", { length: 20 }).default("new").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ──────────────────────────────────────────────
// Email / reminder settings (admin-configurable)
// ──────────────────────────────────────────────

// Single-row config for the email reminder system. The Admin page (phase 5)
// CRUDs this; the trial + renewal workers read it (enabled gate +
// reminderOffsetsDays). An absent row → safe defaults (enabled, [3,2,1]).
export const emailSettings = pgTable("email_settings", {
  id: varchar("id", { length: 20 }).primaryKey().default("default"),
  enabled: boolean("enabled").default(true).notNull(),
  // Days-before thresholds to send reminders, e.g. [3,2,1]. Drives BOTH the
  // in-app notification + the email for trial AND subscription renewal.
  reminderOffsetsDays: jsonb("reminder_offsets_days")
    .$type<number[]>()
    .default([3, 2, 1])
    .notNull(),
  senderName: text("sender_name"),
  replyTo: text("reply_to"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// D15 — admin overrides for the email template copy. One row per
// (templateKey, locale); `fields` holds a partial Variant (subject/preheader/
// badge/heading/body/cta) that overlays the compiled-in COPY default. Absent
// row or absent field = compiled default. The {n} placeholder still substitutes.
export const emailTemplateOverrides = pgTable(
  "email_template_override",
  {
    templateKey: varchar("template_key", { length: 40 }).notNull(),
    locale: varchar("locale", { length: 5 }).notNull(),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull(),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.templateKey, table.locale] }),
  ],
);

// ──────────────────────────────────────────────
// Admin panel foundation (F2–F5). See Docs/admin-prd.md §3.
// ──────────────────────────────────────────────

// F5 — generic runtime config store. Resolution precedence (highest first):
// ENV > admin_setting(scope=user) > (scope=tier) > (scope=global) > code default.
// `scopeId` is "" for global (so the unique index dedupes — Postgres treats NULL
// as distinct, which would allow duplicate global rows). Holds knobs currently
// hardcoded/ENV: media caps, plan prices, trial duration, reminder offsets, etc.
export const adminSettings = pgTable(
  "admin_setting",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    key: text("key").notNull(),
    // global | tier | user
    scope: varchar("scope", { length: 10 }).default("global").notNull(),
    // "" (global) | tier name (e.g. "op_buff") | userId. "" not null so the
    // composite unique index works across all scopes.
    scopeId: text("scope_id").default("").notNull(),
    value: jsonb("value").$type<unknown>(),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("admin_setting_key_scope_uq").on(
      table.key,
      table.scope,
      table.scopeId,
    ),
  ],
);

// D8 — Landing CMS. Per-block, per-locale content overrides. Landing components
// read published `value` as an overlay on the hardcoded i18n dictionary (merged
// at I18nProvider); an absent (key,locale) row falls back to the dict, so this
// table is a zero-config additive layer. `key` is the i18n dot-path of the node
// it replaces (e.g. "hero.titleLine1", "faq.items"). `draft` holds unpublished
// edits; publish copies draft -> value + bumps version.
export const cmsContent = pgTable(
  "cms_content",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    key: text("key").notNull(),
    // "id" | "en" — matches the Locale union in src/lib/i18n/context.tsx.
    locale: varchar("locale", { length: 5 }).default("id").notNull(),
    // Published value (what visitors see). null = no published override.
    value: jsonb("value").$type<unknown>(),
    // In-progress edit, preview-only until published.
    draft: jsonb("draft").$type<unknown>(),
    version: integer("version").default(1).notNull(),
    publishedAt: timestamp("published_at"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("cms_content_key_locale_uq").on(table.key, table.locale)],
);

// D13 — Feature/dev flags. Runtime on/off switches (+ optional jsonb value)
// resolved with the same scope precedence as admin_setting (user > tier >
// global). An absent (key,scope,scopeId) row = flag OFF (safe default), so a
// flag is inert until an admin turns it on. First real consumer: maintenance
// mode (maintenance.enabled gates /app for non-staff).
export const featureFlags = pgTable(
  "feature_flag",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    key: text("key").notNull(),
    // global | tier | user (same convention as admin_setting).
    scope: varchar("scope", { length: 10 }).default("global").notNull(),
    scopeId: text("scope_id").default("").notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    // Optional payload for value-bearing flags (e.g. a maintenance message).
    value: jsonb("value").$type<unknown>(),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("feature_flag_key_scope_uq").on(
      table.key,
      table.scope,
      table.scopeId,
    ),
  ],
);

// F3 — persisted audit trail. auditLog() (src/lib/security/audit-log.ts) keeps
// writing single-line JSON to stdout AND dual-writes a row here so the admin
// audit viewer can query/filter. Identifiers are pre-hashed (PII-safe) by the
// logger before they reach this table.
export const auditLogs = pgTable(
  "audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ts: timestamp("ts").defaultNow().notNull(),
    event: text("event").notNull(),
    outcome: varchar("outcome", { length: 10 }).notNull(),
    actorHash: text("actor_hash"),
    targetHash: text("target_hash"),
    ip: text("ip"),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("audit_log_ts_idx").on(table.ts),
    index("audit_log_event_idx").on(table.event),
  ],
);

// F2 — self-hosted analytics event capture (NO 3rd party). trackEvent()
// (src/lib/analytics/track.ts) inserts here fire-and-forget. userId is NOT FK'd
// so events survive account deletion (funnel/cohort integrity); nullable for
// anonymous (pre-login) landing events keyed by anonId instead.
export const analyticsEvents = pgTable(
  "analytics_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ts: timestamp("ts").defaultNow().notNull(),
    event: text("event").notNull(),
    userId: text("user_id"),
    anonId: text("anon_id"),
    sessionId: text("session_id"),
    props: jsonb("props").$type<Record<string, unknown>>(),
    utm: jsonb("utm").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("analytics_event_ts_idx").on(table.ts),
    index("analytics_event_event_idx").on(table.event),
    index("analytics_event_user_idx").on(table.userId),
  ],
);

// F4 — precomputed daily KPI rollups (MRR, new-users, trial-conversion, etc.)
// so admin dashboards don't scan raw tables on every render. `dimsKey` is a
// stable string of `dims` ("" when dimensionless) so the unique index can hold
// one row per (day, metric, dims) combination.
export const dailyRollups = pgTable(
  "daily_rollup",
  {
    // YYYY-MM-DD (UTC day bucket).
    day: text("day").notNull(),
    metric: text("metric").notNull(),
    dims: jsonb("dims").$type<Record<string, unknown>>(),
    dimsKey: text("dims_key").default("").notNull(),
    // bigint (int8): the revenue.settled metric SUMs amount_rp across a day, which
    // overflows int4 (~Rp 2.147B/day, ≈21.7k paying users) — a real ceiling as we
    // scale. mode:"number" stays a JS number (daily totals never approach 2^53).
    value: bigint("value", { mode: "number" }).default(0).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("daily_rollup_uq").on(table.day, table.metric, table.dimsKey),
  ],
);

// F4 — subscription lifecycle history for cohort/retention analysis. settle.ts
// + cancel + expiry append a row on every tier/status transition. NOT FK'd to
// users (survive deletion for cohort integrity).
export const subscriptionHistory = pgTable(
  "subscription_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    subscriptionId: text("subscription_id"),
    fromTier: varchar("from_tier", { length: 20 }),
    toTier: varchar("to_tier", { length: 20 }),
    fromStatus: varchar("from_status", { length: 20 }),
    toStatus: varchar("to_status", { length: 20 }),
    reason: text("reason"),
    at: timestamp("at").defaultNow().notNull(),
  },
  (table) => [index("subscription_history_user_idx").on(table.userId)],
);

// F4 — container lifecycle event log (provision/health/restart/stop/start/
// destroy) for the fleet monitor + reliability signals. NOT FK'd so events
// outlive a destroyed container/user.
export const containerEvents = pgTable(
  "container_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    // provision | health | restart | stop | start | destroy
    event: varchar("event", { length: 24 }).notNull(),
    ok: boolean("ok").default(true).notNull(),
    errorMessage: text("error_message"),
    at: timestamp("at").defaultNow().notNull(),
  },
  (table) => [index("container_event_user_idx").on(table.userId)],
);

// Worker liveness (D12 finisher). One row per background worker, upserted each
// tick by recordHeartbeat() (src/lib/admin/worker-health.ts). The Log panel
// derives "stale" by comparing lastRunAt against now — a worker that stopped
// ticking (crash, boot failure) shows stale even though no error was recorded.
export const workerHeartbeats = pgTable("worker_heartbeat", {
  name: varchar("name", { length: 64 }).primaryKey(),
  lastRunAt: timestamp("last_run_at").notNull(),
  lastOk: boolean("last_ok").default(true).notNull(),
  lastError: text("last_error"),
  intervalMs: integer("interval_ms").default(0).notNull(),
  runs: integer("runs").default(0).notNull(),
  fails: integer("fails").default(0).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Support tickets (D16). User submits keluhan/pengembangan/pertanyaan from the
// /bantuan page (reachable even when their container is down); admin replies +
// sets status from /admin/dukungan; an admin reply drops a notification row for
// the user. `ref` is a friendly display id (AB-XXXXXX); `id` is the real PK.
export const supportTickets = pgTable(
  "support_ticket",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ref: text("ref").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // keluhan | pengembangan | pertanyaan
    category: varchar("category", { length: 16 }).notNull(),
    subject: text("subject").notNull(),
    message: text("message").notNull(),
    // open | in_progress | answered | closed
    status: varchar("status", { length: 16 }).default("open").notNull(),
    reply: text("reply"),
    repliedBy: text("replied_by"),
    repliedAt: timestamp("replied_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("support_ticket_user_idx").on(table.userId, table.createdAt),
    index("support_ticket_status_idx").on(table.status),
  ],
);

// ──────────────────────────────────────────────
// Fase C: Marketplace (D4). Admin-published first-party + 3rd-party seller.
// See Docs/admin-prd.md §4 D4.
// ──────────────────────────────────────────────

// A seller is either AgentBuff itself (first_party, no payout) or a 3rd-party
// creator (third_party, payout via Midtrans Iris — wired later). ownerUserId is
// null for the first-party house seller.
export const sellers = pgTable("seller", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  // first_party | third_party
  type: varchar("type", { length: 12 }).notNull(),
  ownerUserId: text("owner_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  displayName: text("display_name").notNull(),
  // active | suspended
  status: varchar("status", { length: 12 }).default("active").notNull(),
  // Per-seller commission override (platform cut %). Null = use commission_rule.
  commissionPct: integer("commission_pct"),
  payoutInfo: jsonb("payout_info").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// A marketplace item. installSpec carries how the item installs into a user's
// container (skill = clawhub slug; mcp_app = command/args/env per the Kemampuan
// token-form). Lifecycle: draft -> pending -> approved -> published (or
// rejected / delisted).
export const listings = pgTable(
  "listing",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    sellerId: text("seller_id")
      .notNull()
      .references(() => sellers.id, { onDelete: "cascade" }),
    // skill | mcp_app | bundle
    kind: varchar("kind", { length: 16 }).notNull(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    description: text("description"),
    category: varchar("category", { length: 40 }),
    version: text("version"),
    priceRp: integer("price_rp").default(0).notNull(),
    // draft | pending | approved | published | rejected | delisted
    status: varchar("status", { length: 12 }).default("draft").notNull(),
    installSpec: jsonb("install_spec").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    reviewNotes: text("review_notes"),
    createdBy: text("created_by"),
    publishedAt: timestamp("published_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("listing_status_idx").on(table.status),
    index("listing_seller_idx").on(table.sellerId),
  ],
);

// Commission rule = platform cut percent. Resolution: seller.commissionPct >
// rule(scope=seller) > rule(scope=category) > rule(scope=global) > default 20%.
// scopeId "" for global. First-party listings are exempt (0%).
export const commissionRules = pgTable(
  "commission_rule",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // global | category | seller
    scope: varchar("scope", { length: 12 }).default("global").notNull(),
    scopeId: text("scope_id").default("").notNull(),
    pct: integer("pct").notNull(),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commission_rule_scope_uq").on(table.scope, table.scopeId),
  ],
);

// C3 Phase C — a grouped Iris disbursement to ONE seller. Dual-control:
// createdBy submits, a DIFFERENT approvedBy approves. irisReferenceNo is our
// idempotent reference_no sent to Iris; irisPayoutRef is Iris's returned id.
export const payoutBatches = pgTable(
  "payout_batch",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    sellerId: text("seller_id")
      .notNull()
      .references(() => sellers.id, { onDelete: "cascade" }),
    totalNetRp: integer("total_net_rp").notNull(),
    // created | submitted | approved | completed | failed
    status: varchar("status", { length: 16 }).default("created").notNull(),
    irisReferenceNo: text("iris_reference_no").unique(),
    irisPayoutRef: text("iris_payout_ref"),
    createdBy: text("created_by"),
    approvedBy: text("approved_by"),
    submittedAt: timestamp("submitted_at"),
    approvedAt: timestamp("approved_at"),
    completedAt: timestamp("completed_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("payout_batch_seller_idx").on(table.sellerId)],
);

// C3 Phase B — per-sale commission split. ONE row per settled marketplace sale
// (transactionId UNIQUE = idempotency: a webhook replay can't double-credit).
// grossRp = what the buyer paid; commissionRp = platform cut; netRp = seller
// take. holdUntil = chargeback window before the row becomes payout-eligible.
export const payoutLedger = pgTable(
  "payout_ledger",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    transactionId: text("transaction_id")
      .references(() => transactions.id, { onDelete: "set null" })
      .unique(),
    listingId: text("listing_id").references(() => listings.id, {
      onDelete: "set null",
    }),
    sellerId: text("seller_id")
      .notNull()
      .references(() => sellers.id, { onDelete: "cascade" }),
    grossRp: integer("gross_rp").notNull(),
    commissionPct: integer("commission_pct").notNull(),
    commissionRp: integer("commission_rp").notNull(),
    netRp: integer("net_rp").notNull(),
    // ISO week bucket, e.g. "2026-W25".
    period: text("period").notNull(),
    holdUntil: timestamp("hold_until").notNull(),
    // pending | eligible | batched | paid | failed
    status: varchar("status", { length: 16 }).default("pending").notNull(),
    batchId: text("batch_id").references(() => payoutBatches.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("payout_ledger_seller_status_idx").on(table.sellerId, table.status),
    index("payout_ledger_batch_idx").on(table.batchId),
  ],
);

// D10/D14 — promo coupons. `used` is incremented atomically at charge time
// (reserve) and released if the charge call fails or the payment lapses, so
// maxUses is enforced even under concurrent redemptions. type=percent (value =
// 1..100) or fixed (value = Rp off). tierScope "" = any tier.
export const coupons = pgTable(
  "coupon",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    code: text("code").notNull().unique(),
    // percent | fixed
    type: varchar("type", { length: 10 }).notNull(),
    value: integer("value").notNull(),
    // "" = all tiers; else a tier name (e.g. "op_buff") it is restricted to.
    tierScope: varchar("tier_scope", { length: 20 }).default("").notNull(),
    maxUses: integer("max_uses"), // null = unlimited
    used: integer("used").default(0).notNull(),
    expiresAt: timestamp("expires_at"), // null = no expiry
    active: boolean("active").default(true).notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("coupon_code_uq").on(table.code)],
);

// First-party skill/app catalog (D13). DB home for what was the hardcoded
// CATALOG in skill-catalog.ts — admin owns title/copy/price/status/etc. without a
// redeploy. Seeded once from the hardcoded entries; thereafter authoritative.
// `capabilities` is a JSON string[] (detail-drawer bullets). status drives the
// Shop Buy-vs-"Segera Hadir" gate + checkout (isPurchasable).
export const skillCatalog = pgTable("skill_catalog", {
  key: text("key").primaryKey(),
  title: text("title").notNull(),
  tagline: text("tagline").default("").notNull(),
  description: text("description").default("").notNull(),
  priceRp: integer("price_rp").default(0).notNull(),
  // umkm | creator | produktivitas | operasional | riset
  category: varchar("category", { length: 20 }).default("umkm").notNull(),
  icon: text("icon").default("Package").notNull(),
  // skill | tool | plugin | connector | app
  unlock: varchar("unlock", { length: 12 }).default("connector").notNull(),
  // available | coming_soon
  status: varchar("status", { length: 12 }).default("coming_soon").notNull(),
  byok: boolean("byok").default(false).notNull(),
  // one_time | subscription
  billing: varchar("billing", { length: 12 }).default("one_time").notNull(),
  // clawhub | direct
  source: varchar("source", { length: 10 }).default("direct").notNull(),
  version: text("version"), // null = latest
  coverEmoji: text("cover_emoji").default("📦").notNull(),
  // cyan | fuchsia | amber | emerald | violet | rose
  accent: varchar("accent", { length: 10 }).default("cyan").notNull(),
  featured: boolean("featured").default(false).notNull(),
  capabilities: jsonb("capabilities").$type<string[]>().default([]).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Admin broadcast announcement (D9 CMS-app). Each send records one row here +
// fans out into per-user `notification` rows (which the app already consumes),
// so a broadcast is immediately visible in-app — no new consumer surface.
export const announcements = pgTable("announcement", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  message: text("message").notNull(),
  // Which app tab the notification appears under (matches notification.tab).
  tab: varchar("tab", { length: 20 }).default("chat").notNull(),
  // all | onboarded | trial | subscribed
  audience: varchar("audience", { length: 16 }).default("all").notNull(),
  highPriority: boolean("high_priority").default(false).notNull(),
  actionLabel: text("action_label"),
  actionHref: text("action_href"),
  recipientCount: integer("recipient_count").default(0).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
