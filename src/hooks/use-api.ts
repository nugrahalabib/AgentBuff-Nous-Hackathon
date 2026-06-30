"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PLANS, type PlanDef, type PlanTier } from "@/lib/billing/plans";

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status, body });
  }
  return res.json();
}

// ── User Profile ────────────────────────────

export function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    queryFn: () => apiFetch<ProfileResponse>("/api/users/me/profile"),
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateProfileInput) =>
      apiFetch("/api/users/me/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profile"] }),
  });
}

export function useCompleteOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: OnboardingInput) =>
      apiFetch("/api/users/me/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["energy"] });
    },
  });
}

// Agents, chat, engine config, and models are served via the OpenClaw WebSocket
// gateway (see src/hooks/use-gateway.ts). The REST endpoints for those
// concerns have been removed.

// ── Energy ──────────────────────────────────

export function useEnergy() {
  return useQuery({
    queryKey: ["energy"],
    queryFn: () => apiFetch<EnergyResponse>("/api/billing/energy"),
  });
}

// ── Notifications ───────────────────────────

export function useNotifications(tab?: string) {
  return useQuery({
    queryKey: ["notifications", tab],
    queryFn: () =>
      apiFetch<NotificationRow[]>(
        `/api/notifications${tab ? `?tab=${tab}` : ""}`,
      ),
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch("/api/notifications/read-all", { method: "PUT" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/notifications/${id}/read`, { method: "PUT" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useNotifPrefs() {
  return useQuery({
    queryKey: ["notif-prefs"],
    queryFn: () => apiFetch<NotifPrefsResponse>("/api/notifications/preferences"),
  });
}

export function useUpdateNotifPrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<NotifPrefsResponse>) =>
      apiFetch("/api/notifications/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notif-prefs"] }),
  });
}

// ── Billing ─────────────────────────────────

export function useBundles() {
  return useQuery({
    queryKey: ["bundles"],
    queryFn: () => apiFetch<EnergyBundle[]>("/api/billing/bundles"),
  });
}

// Effective plan pricing (admin-override-aware, D14) for client DISPLAY only.
// placeholderData = the static catalog so a price always renders instantly and
// the UI degrades to the compiled-in default if the feed is unreachable. The
// CHARGE path never trusts this — checkout re-confirms server-side.
export function usePricing() {
  return useQuery({
    queryKey: ["pricing"],
    queryFn: () =>
      apiFetch<{ plans: Record<PlanTier, PlanDef> }>("/api/pricing"),
    placeholderData: { plans: PLANS },
    staleTime: 30_000,
  });
}

export function useSubscription() {
  return useQuery({
    queryKey: ["subscription"],
    queryFn: () => apiFetch<SubscriptionRow | null>("/api/billing/subscription"),
  });
}

export function useCreateSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { tier: string; billingCycle: string; paymentType: string }) =>
      apiFetch<ChargeResponse>("/api/billing/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["subscription"] }),
  });
}

export function useCancelSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { freeze?: boolean }) =>
      apiFetch("/api/billing/subscription/cancel", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["subscription"] }),
  });
}

export function useTopUpEnergy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { bundleId: string; paymentType: string }) =>
      apiFetch<ChargeResponse>("/api/billing/energy/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["energy"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
    },
  });
}

export interface TransactionFilters {
  period?: string;
  category?: string;
  /** UI status bucket: "success" | "pending" | "failed". */
  status?: string;
  /** Free-text search over description / order id / amount. */
  q?: string;
  /** Custom range bounds (ISO date). Override the period preset when set. */
  from?: string;
  to?: string;
}

export function useTransactions(filters: TransactionFilters = {}) {
  const { period, category, status, q, from, to } = filters;
  const params = new URLSearchParams();
  if (period) params.set("period", period);
  if (category) params.set("category", category);
  if (status) params.set("status", status);
  if (q) params.set("q", q);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return useQuery({
    queryKey: ["transactions", period, category, status, q, from, to],
    queryFn: () =>
      apiFetch<TransactionRow[]>(
        `/api/billing/transactions${qs ? `?${qs}` : ""}`,
      ),
  });
}

export function usePaymentMethods() {
  return useQuery({
    queryKey: ["payment-methods"],
    queryFn: () => apiFetch<PaymentMethodRow[]>("/api/billing/payment-methods"),
  });
}

export function useAddPaymentMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { type: string; brand: string; lastFour?: string; expiry?: string }) =>
      apiFetch("/api/billing/payment-methods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["payment-methods"] }),
  });
}

export function useDeletePaymentMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/billing/payment-methods/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["payment-methods"] }),
  });
}

// ── Dashboard (Ringkasan tab) ───────────────
//
// Hook-hook ini fetch dari endpoint dashboard yang baru di /api/users/me/*.
// Disengaja terpisah dari useSubscription lama (yang masih dipakai basecamp
// billing-settings) untuk avoid breaking change. Resolver state ada di
// src/lib/dashboard/.

export function useSubscriptionState() {
  return useQuery({
    queryKey: ["subscription-state"],
    queryFn: () =>
      apiFetch<{ subscription: SubscriptionStateResponse }>(
        "/api/users/me/subscription",
      ).then((r) => r.subscription),
    // 60s stale — subscription state jarang berubah, naik harus invalidate
    // setelah billing-complete postMessage dari popup.
    staleTime: 60_000,
  });
}

export function useTodayStats() {
  return useQuery({
    queryKey: ["today-stats"],
    queryFn: () =>
      apiFetch<{ stats: TodayStatsResponse }>(
        "/api/users/me/dashboard/today-stats",
      ).then((r) => r.stats),
    // 30s stale — task carry + energy used update lebih sering, refetch on
    // window focus untuk fresh feel.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useAttention() {
  return useQuery({
    queryKey: ["dashboard-attention"],
    queryFn: () =>
      apiFetch<AttentionPayloadResponse>("/api/users/me/dashboard/attention"),
    // 30s stale — alert state cepat berubah saat container throttle / energy
    // turun mendekati threshold.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useChannelsDashboard() {
  return useQuery({
    queryKey: ["dashboard-channels"],
    queryFn: () =>
      apiFetch<ChannelsDashboardResponse>("/api/users/me/dashboard/channels"),
    // 30s stale — channel state sering berubah (login/logout/reconnect),
    // tapi gateway juga broadcast `channels.status` event yang akan trigger
    // invalidation manual dari komponen via queryClient.invalidateQueries.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    // Saat WS reconnect setelah engine restart (logout / config change yang
    // trigger SIGUSR1), TanStack default tidak refetch otomatis — kalau cuma
    // bergantung ke WS event broadcast, broadcast bisa miss saat WS lagi
    // disconnect. Set refetchOnReconnect supaya tiap kali browser detect
    // network reconnect (termasuk after WS gateway hang up), query refetch.
    refetchOnReconnect: "always",
  });
}

// ── Types ───────────────────────────────────

interface EnergyResponse {
  balance: number;
  maxBalance: number;
  lastTopupAt: string | null;
}

interface NotificationRow {
  id: string;
  tab: string;
  icon: string | null;
  text: string;
  highPriority: boolean;
  read: boolean;
  actionLabel: string | null;
  actionHref: string | null;
  createdAt: string;
}

interface NotifPrefsResponse {
  aiTasks: boolean;
  system: boolean;
  store: boolean;
  lowEnergy: boolean;
  waEnabled: boolean;
}

interface EnergyBundle {
  id: string;
  name: string;
  energy: number;
  bonusEnergy: number;
  priceRp: number;
}

interface SubscriptionRow {
  id: string;
  tier: string;
  billingCycle: string;
  priceRp: number;
  status: string;
  startsAt: string;
  expiresAt: string;
  autoRenew: boolean;
  frozenPriceRp: number | null;
}

// Mirrors src/lib/dashboard/subscription-resolver.ts SubscriptionState.
// Tetap di-define ulang di sini supaya use-api.ts tidak import dari /lib/dashboard
// (avoid circular hierarchy: hooks → lib/dashboard → db). Server response
// shape locked, jadi safe duplicate.
export interface SubscriptionStateResponse {
  tier: "starter" | "op_buff" | "guild_master";
  status: "active" | "starter_default" | "expired" | "canceled";
  expiresAt: string | null;
  autoRenew: boolean | null;
  billingCycle: "monthly" | "yearly" | null;
  priceRp: number | null;
  isExpiringSoon: boolean;
  daysUntilExpire: number | null;
}

export interface TodayMetricResponse {
  today: number;
  yesterday: number | null;
  trendPct: number | null;
  isFreshStart: boolean;
}

export interface TodayStatsResponse {
  taskCarry: TodayMetricResponse;
  /** Total task (user messages) 7 hari terakhir inklusif. */
  weekCarry: number;
  energyUsed: TodayMetricResponse;
  channels: { totalConfigured: number; active: number; activeIds: string[] };
  agents: { total: number; standby: number };
  engineLive: boolean;
  generatedAt: string;
}

export type AttentionSeverity = "critical" | "warning" | "info";

export interface AttentionItemResponse {
  id: string;
  severity: AttentionSeverity;
  icon: string;
  title: string;
  description: string;
  action?: {
    label: string;
    kind: "navigate" | "popup" | "external";
    href: string;
  };
}

export interface AttentionPayloadResponse {
  items: AttentionItemResponse[];
  generatedAt: string;
}

// Channels dashboard — mirrors server payload shape
// (src/lib/dashboard/channels-service.ts ChannelsDashboardPayload).

export interface ChannelAccountResponse {
  accountId: string;
  name?: string | null;
  enabled?: boolean;
  configured?: boolean;
  linked?: boolean;
  running?: boolean;
  connected?: boolean;
  reconnectAttempts?: number;
  lastConnectedAt?: number | null;
  lastError?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  lastProbeAt?: number | null;
  busy?: boolean;
  activeRuns?: number;
  mode?: string;
  dmPolicy?: string;
  /** Human-facing account identity from the bridge. WhatsApp: phone (E.164
   * digits) + displayName (pushname). Telegram: botId (numeric token prefix). */
  phone?: string | null;
  displayName?: string | null;
  botId?: string | null;
  /** Agent yang handle akun ini (per-account binding). null = pakai default. */
  routedAgentId?: string | null;
  probe?: unknown;
  audit?: unknown;
  application?: unknown;
}

export interface ChannelDashboardEntryResponse {
  channelId: string;
  label: string;
  detailLabel?: string;
  systemImage?: string;
  accounts: ChannelAccountResponse[];
  defaultAccountId?: string;
  summary: {
    totalAccounts: number;
    onlineAccounts: number;
    hasError: boolean;
    hasReconnectLoop: boolean;
  };
  usage: {
    totalToday: number;
    inboundToday: number;
    outboundToday: number;
  };
  /** Agent yang handle channel ini (dari `bindings[]` array di config).
   * null = pakai default agent (no explicit binding). */
  routedAgentId: string | null;
  rawStatus: unknown;
}

export interface PerProfileChannelsSnapshotResponse {
  profileId: string;
  channels: ChannelDashboardEntryResponse[];
  bindings: unknown[];
  totals: { channels: number; accounts: number; online: number };
}

export interface ChannelsDashboardResponse {
  generatedAt: string;
  engineLive: boolean;
  connectedChannels: ChannelDashboardEntryResponse[];
  /** Per-agent (named profile) channel breakdown — multi-agent matrix view.
   *  Keyed by agentId. Optional: only present once the bridge emits it. */
  profiles?: Record<string, PerProfileChannelsSnapshotResponse>;
  totals: {
    channels: number;
    accounts: number;
    online: number;
    inboundToday: number;
    outboundToday: number;
  };
}

interface ChargeResponse {
  orderId: string;
  chargeResponse: {
    status_code: string;
    transaction_status: string;
    actions?: { name: string; method: string; url: string }[];
    qr_string?: string;
    va_numbers?: { bank: string; va_number: string }[];
  };
}

interface TransactionRow {
  id: string;
  type: string;
  description: string;
  amountRp: number;
  energyDelta: number;
  status: string;
  paymentRef: string | null;
  paymentMethod: string | null;
  paidAt: string | null;
  midtransOrderId: string | null;
  createdAt: string;
}

interface PaymentMethodRow {
  id: string;
  type: string;
  brand: string;
  lastFour: string | null;
  expiry: string | null;
  isDefault: boolean;
}

interface ProfileResponse {
  profile: {
    nickname: string | null;
    displayName: string | null;
    onboarded: boolean;
    focus: string | null;
    whatsapp: string | null;
    dob: string | null;
    role: string | null;
    industryIds: string | null;
    interestIds: string | null;
    businessName: string | null;
    jurusan: string | null;
    city: string | null;
    avatarEmoji: string | null;
  } | null;
  engine: {
    mode: string;
    providerId: string | null;
  } | null;
  trial: {
    status: string;
    endsAt: string;
    daysLeft: number;
  } | null;
  user: {
    id: string;
    name: string | null;
    email: string | null;
  };
}

interface UpdateProfileInput {
  legalName?: string;
  displayName?: string;
  nickname?: string;
  whatsapp?: string;
  dob?: string;
  role?: string;
  industryIds?: string;
  avatarEmoji?: string;
}

interface OnboardingInput {
  fullName?: string;
  nickname: string;
  whatsapp?: string;
  dob?: string;
  role?: string;
  industryIds?: string;
  interestIds?: string;
  focus?: string;
}
