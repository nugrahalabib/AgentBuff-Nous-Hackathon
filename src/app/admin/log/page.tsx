import { AuditLogBrowser } from "../_components/audit-log-browser";
import { WorkerHealthPanel } from "../_components/worker-health-panel";

export const dynamic = "force-dynamic";

export default function AdminLogPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Log & Monitoring</h2>
        <p className="text-sm text-zinc-500">
          Audit trail (identifier ter-hash, PII-safe). Filter per event / outcome.
        </p>
      </div>
      <WorkerHealthPanel />
      <AuditLogBrowser />
    </div>
  );
}
