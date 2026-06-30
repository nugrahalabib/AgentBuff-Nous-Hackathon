import { AnalyticsBrowser } from "../_components/analytics-browser";

export const dynamic = "force-dynamic";

export default function AdminAnalyticsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Analitik</h2>
        <p className="text-sm text-zinc-500">
          Funnel akuisisi (snapshot dari DB) + aktivitas event self-host (F2).
        </p>
      </div>
      <AnalyticsBrowser />
    </div>
  );
}
