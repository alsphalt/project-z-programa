export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

export function datetime(value: string | number | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relative(value: string | number | Date | null | undefined): string {
  if (!value) return "never";
  const date = value instanceof Date ? value : new Date(value);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return "—";
  if (diff < 45_000) return "just now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days}d ago`;
  return datetime(date);
}

export function duration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "—";
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

export const STATUS_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  ONLINE: { dot: "bg-emerald-400", text: "text-emerald-300", label: "Online" },
  CONNECTED: { dot: "bg-emerald-400", text: "text-emerald-300", label: "Connected" },
  SYNCHRONIZED: { dot: "bg-emerald-400", text: "text-emerald-300", label: "Synchronized" },
  SUCCEEDED: { dot: "bg-emerald-400", text: "text-emerald-300", label: "Succeeded" },
  DISCONNECTED: { dot: "bg-rose-400", text: "text-rose-300", label: "Disconnected" },
  OFFLINE: { dot: "bg-slate-500", text: "text-slate-400", label: "Offline" },
  STARTING: { dot: "bg-amber-400", text: "text-amber-300", label: "Starting" },
  RESTARTING: { dot: "bg-amber-400", text: "text-amber-300", label: "Restarting" },
  SYNCING: { dot: "bg-sky-400", text: "text-sky-300", label: "Scanning" },
  CRASHED: { dot: "bg-rose-500", text: "text-rose-300", label: "Crashed" },
  UNKNOWN: { dot: "bg-slate-500", text: "text-slate-400", label: "Unknown" },
  FAILED: { dot: "bg-rose-500", text: "text-rose-300", label: "Failed" },
  CONFLICT: { dot: "bg-amber-400", text: "text-amber-300", label: "Conflict" },
  DRAFT: { dot: "bg-violet-400", text: "text-violet-300", label: "Draft" },
  REMOTE_CHANGES: { dot: "bg-amber-400", text: "text-amber-300", label: "Remote changes" },
  PENDING: { dot: "bg-slate-400", text: "text-slate-300", label: "Pending" },
  LOCKED: { dot: "bg-sky-400", text: "text-sky-300", label: "Locked" },
  BACKING_UP: { dot: "bg-sky-400", text: "text-sky-300", label: "Backing up" },
  UPLOADING: { dot: "bg-sky-400", text: "text-sky-300", label: "Uploading" },
  VERIFYING: { dot: "bg-sky-400", text: "text-sky-300", label: "Verifying" },
  HEALTH_CHECK: { dot: "bg-sky-400", text: "text-sky-300", label: "Health check" },
  ROLLED_BACK: { dot: "bg-amber-400", text: "text-amber-300", label: "Rolled back" },
  CANCELLED: { dot: "bg-slate-500", text: "text-slate-400", label: "Cancelled" },
  UNREACHABLE: { dot: "bg-rose-500", text: "text-rose-300", label: "Unreachable" },
  DEGRADED: { dot: "bg-amber-400", text: "text-amber-300", label: "Degraded" },
  RUNNING: { dot: "bg-sky-400", text: "text-sky-300", label: "Running" },
  PARTIAL: { dot: "bg-amber-400", text: "text-amber-300", label: "Partial" },
};

export function statusStyle(status: string | null | undefined) {
  return STATUS_STYLES[(status ?? "UNKNOWN").toUpperCase()] ?? STATUS_STYLES.UNKNOWN;
}
