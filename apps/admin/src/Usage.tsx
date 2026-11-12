// © Infinitum Corporation®. All rights reserved.
//
// How the desk was used recently, read from the audit log by the API: searches that ran or were refused,
// why they were refused, and what reviewers decided. Counts only; no subject identifiers.

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@eidetic/ui";

interface UsageStats {
  since: string;
  hours: number;
  searches: { total: number; ran: number; refused: number };
  byPurpose: Array<{ purposeCode: string; ran: number; refused: number }>;
  refusalsByCode: Array<{ code: string; count: number }>;
  decisions: { confirm: number; reject: number; inconclusive: number; refused: number };
  pendingReviews: number;
}

type Call = <T>(path: string, init?: RequestInit) => Promise<T>;

const WINDOWS = [
  { hours: 24, label: "Last 24 hours" },
  { hours: 24 * 7, label: "Last 7 days" },
  { hours: 24 * 30, label: "Last 30 days" },
];

export function Usage({ api, refresh }: { api: Call; refresh: unknown }) {
  const [hours, setHours] = useState(24);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<UsageStats>(`/v1/stats/usage?hours=${hours}`)
      .then((body) => {
        setStats(body);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [api, hours, refresh]);

  const figure = (value: number, label: string) => (
    <div className="rounded-md border border-border p-3">
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Usage</CardTitle>
          <select
            aria-label="Usage window"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={hours}
            onChange={(event) => setHours(Number(event.target.value))}
          >
            {WINDOWS.map((window) => (
              <option key={window.hours} value={window.hours}>
                {window.label}
              </option>
            ))}
          </select>
        </div>
      </CardHeader>
      <CardContent className="space-y-4" data-testid="usage">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {stats && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {figure(stats.searches.ran, "Searches run")}
              {figure(stats.searches.refused, "Searches refused")}
              {figure(stats.decisions.confirm + stats.decisions.reject + stats.decisions.inconclusive, "Review decisions")}
              {figure(stats.pendingReviews, "Waiting for a reviewer")}
            </div>
            <p className="text-xs text-muted-foreground">
              {`Confirmed ${stats.decisions.confirm} · rejected ${stats.decisions.reject} · inconclusive ${stats.decisions.inconclusive} · refused at review ${stats.decisions.refused}`}
            </p>
            {stats.byPurpose.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium">By purpose</p>
                <ul className="space-y-1 text-sm">
                  {stats.byPurpose.map((row) => (
                    <li key={row.purposeCode} className="flex justify-between gap-3">
                      <span className="font-mono text-xs">{row.purposeCode}</span>
                      <span className="text-muted-foreground">{`${row.ran} run · ${row.refused} refused`}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {stats.refusalsByCode.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium">Why searches were refused</p>
                <ul className="space-y-1 text-sm">
                  {stats.refusalsByCode.map((row) => (
                    <li key={row.code} className="flex justify-between gap-3">
                      <span className="font-mono text-xs">{row.code}</span>
                      <span className="tabular-nums text-muted-foreground">{row.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {stats.searches.total === 0 && <p className="text-sm text-muted-foreground">No searches in this window.</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
