// © Infinitum Corporation®. All rights reserved.
import { FirmSuite } from "./firm/FirmSuite";

import { useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, Label, Textarea } from "@eidetic/ui";
import { CidAccount, CidSignIn } from "./CidSignIn";
import { useCumulusId } from "./cid";

interface Me {
  id: string;
  displayName: string;
  role: "admin" | "operator" | "reviewer" | "auditor";
}

interface ReviewSummary {
  reviewId: string;
  status: "pending" | "decided";
  finalDecision: "confirm" | "reject" | "inconclusive" | null;
  purposeCode: string;
  datasetId: string;
  legalBasis: string;
  createdAt: string;
  topConfidence: number | null;
  subjectName: string | null;
  searchedBy: { id: string; displayName: string };
}

interface Candidate {
  cid: string;
  displayName: string;
  confidence: number;
  rank: number;
  evidence: Array<{ kind: string; summary: string; weight: number }>;
}

interface ReviewDetail extends ReviewSummary {
  notes: string | null;
  selectedCid: string | null;
  candidates: Candidate[];
  searchId: string;
}

interface ApiError extends Error {
  code?: string;
  matchRan?: boolean;
}

async function api<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? `Request failed (${response.status})`) as ApiError;
    error.code = body?.error?.code;
    error.matchRan = body?.error?.matchRan;
    throw error;
  }
  return body as T;
}

export function App() {
  const { profile, token: cidToken } = useCumulusId();
  const token = cidToken ?? "";
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [health, setHealth] = useState<"loading" | "up" | "down">("loading");
  const [demoMode, setDemoMode] = useState(false);
  const [queue, setQueue] = useState<ReviewSummary[]>([]);
  const [filter, setFilter] = useState<"pending" | "decided">("pending");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [notes, setNotes] = useState("");
  const [selectedCid, setSelectedCid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/v1/health")
      .then(async (response) => {
        if (!response.ok) throw new Error("down");
        const body = await response.json();
        setDemoMode(Boolean(body.demoMode));
        setHealth("up");
      })
      .catch(() => setHealth("down"));
  }, []);

  async function loadQueue(nextFilter = filter) {
    const body = await api<{ reviews: ReviewSummary[] }>(`/v1/reviews?status=${nextFilter}`, token);
    setQueue(body.reviews);
    return body.reviews;
  }

  useEffect(() => {
    setMe(null);
    setMeError(null);
    if (health !== "up" || !token) return;
    api<{ actor: Me }>("/v1/me", token)
      .then((body) => setMe(body.actor))
      .catch((reason: ApiError) => setMeError(reason.message));
  }, [health, token]);

  useEffect(() => {
    if (!me) return;
    setError(null);
    loadQueue().catch((reason: ApiError) => setError(reason.message));
    // the signed-in actor and filter are the real dependencies
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, filter]);

  useEffect(() => {
    if (!selectedId || !me) return;
    api<ReviewDetail>(`/v1/reviews/${selectedId}`, token)
      .then((body) => {
        setDetail(body);
        setSelectedCid(body.candidates[0]?.cid ?? null);
        setNotes("");
        setReceipt(null);
      })
      .catch((reason: ApiError) => setError(reason.message));
  }, [selectedId, me]);

  async function seed() {
    setBusy(true);
    setError(null);
    try {
      const seeded = await api<{ reviewId: string }>("/v1/demo/seed", token, { method: "POST", body: "{}" });
      setFilter("pending");
      const reviews = await api<{ reviews: ReviewSummary[] }>("/v1/reviews?status=pending", token);
      setQueue(reviews.reviews);
      setSelectedId(seeded.reviewId);
    } catch (reason) {
      setError((reason as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "confirm" | "reject" | "inconclusive") {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ audit: { hash: string }; message: string }>(`/v1/reviews/${detail.reviewId}/decide`, token, {
        method: "POST",
        body: JSON.stringify({
          decision,
          notes,
          ...(decision === "confirm" && selectedCid ? { selectedCid } : {}),
        }),
      });
      setReceipt(`${result.message} Audit hash ${result.audit.hash}.`);
      await loadQueue();
      const refreshed = await api<ReviewDetail>(`/v1/reviews/${detail.reviewId}`, token);
      setDetail(refreshed);
    } catch (reason) {
      const apiError = reason as ApiError;
      setError(apiError.matchRan === false ? `${apiError.message} No new match was run.` : apiError.message);
    } finally {
      setBusy(false);
    }
  }

  const canDecide = me?.role === "reviewer" && detail?.status === "pending" && detail.searchedBy.id !== me.id;

  return (
    <div className="min-h-screen">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="app-bar">
        <a className="app-wordmark" href="/">
          ei·det·ic<sup className="tm">™</sup>
        </a>
        <nav className="app-nav" aria-label="Main">
          <a href="/" aria-current="page">Review desk</a>
        </nav>
        <CidAccount profile={profile} />
      </header>

      <main id="main" className="app-main grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="app-head lg:col-span-2">
          <div>
            <h1>Review desk</h1>
            <p className="max-w-xl">A score is evidence. The decision is yours. Nothing here becomes a match until a reviewer records it.</p>
          </div>
        </div>
        {health === "loading" && <p className="text-muted-foreground lg:col-span-2">Checking the API…</p>}
        {health === "down" && (
          <Card className="lg:col-span-2">
            <CardContent className="pt-5">
              <p>The API is not reachable. Start it with <code className="font-mono">pnpm dev</code> or Docker Compose, then reload.</p>
            </CardContent>
          </Card>
        )}
        {health === "up" && !me && (
          <div className="lg:col-span-2">
            <CidSignIn desk="review desk" error={meError} signedIn={Boolean(token)} />
          </div>
        )}
        {health === "up" && me && (
          <>
            <section className="space-y-3">
              <div className="flex gap-2">
                <Button variant={filter === "pending" ? "default" : "outline"} size="sm" onClick={() => setFilter("pending")}>
                  Waiting
                </Button>
                <Button variant={filter === "decided" ? "default" : "outline"} size="sm" onClick={() => setFilter("decided")}>
                  Decided
                </Button>
              </div>
              {queue.length === 0 && (
                <Card>
                  <CardContent className="space-y-3 pt-5 text-sm">
                    <p>Nothing is in this queue. Searches appear here only after purpose and consent both pass.</p>
                    {demoMode && me?.role === "admin" && filter === "pending" && (
                      <Button onClick={seed} disabled={busy}>
                        Load synthetic demo
                      </Button>
                    )}
                  </CardContent>
                </Card>
              )}
              {queue.map((item) => (
                <button
                  key={item.reviewId}
                  className={`w-full rounded-lg border px-3 py-3 text-left ${selectedId === item.reviewId ? "border-primary bg-card" : "border-border bg-card/60"}`}
                  onClick={() => setSelectedId(item.reviewId)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{item.subjectName ?? "No leading candidate"}</span>
                    <Badge variant={item.finalDecision ? "secondary" : "outline"}>{item.finalDecision ?? "Unconfirmed"}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.purposeCode} · {item.topConfidence === null ? "no score" : item.topConfidence.toFixed(2)}
                  </p>
                </button>
              ))}
            </section>

            <section>
              {!detail && (
                <Card>
                  <CardContent className="pt-5 text-sm text-muted-foreground">
                    Select a review. Confidence stays labeled unconfirmed until you record a decision.
                  </CardContent>
                </Card>
              )}
              {detail && (
                <Card>
                  <CardContent className="space-y-4 pt-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Unconfirmed similarity</p>
                        <p className="font-mono text-4xl text-primary">{detail.topConfidence === null ? "—" : detail.topConfidence.toFixed(2)}</p>
                        <p className="text-sm text-muted-foreground">
                          {detail.purposeCode} · {detail.legalBasis} · {detail.datasetId}
                        </p>
                      </div>
                      <Badge variant={detail.finalDecision ? "default" : "outline"}>
                        {detail.finalDecision ? `Human decision: ${detail.finalDecision}` : "Waiting for a person"}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">Searched by {detail.searchedBy.displayName}. You cannot decide a search you ran.</p>
                    <div className="space-y-3">
                      {detail.candidates.map((candidate) => (
                        <label key={candidate.cid} className="block rounded-md border border-border p-3">
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-medium">
                              {candidate.rank}. {candidate.displayName}
                            </span>
                            <span className="font-mono text-sm">{candidate.confidence.toFixed(2)}</span>
                          </div>
                          <p className="mt-1 font-mono text-xs text-muted-foreground">{candidate.cid}</p>
                          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                            {candidate.evidence.map((item) => (
                              <li key={`${candidate.cid}-${item.kind}-${item.summary}`}>{item.summary}</li>
                            ))}
                          </ul>
                          {detail.status === "pending" && (
                            <span className="mt-2 flex items-center gap-2 text-sm">
                              <input
                                type="radio"
                                name="candidate"
                                checked={selectedCid === candidate.cid}
                                onChange={() => setSelectedCid(candidate.cid)}
                              />
                              Select if confirming
                            </span>
                          )}
                        </label>
                      ))}
                      {detail.candidates.length === 0 && <p className="text-sm">No candidate was returned. Reject or mark the review inconclusive.</p>}
                    </div>
                    {detail.status === "pending" && (
                      <div className="space-y-2">
                        <Label htmlFor="notes">Decision note</Label>
                        <Textarea
                          id="notes"
                          value={notes}
                          onChange={(event) => setNotes(event.target.value)}
                          placeholder="Why are you confirming, rejecting, or leaving this inconclusive?"
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button disabled={!canDecide || busy} onClick={() => decide("confirm")}>
                            Confirm
                          </Button>
                          <Button variant="outline" disabled={!canDecide || busy} onClick={() => decide("reject")}>
                            Reject
                          </Button>
                          <Button variant="secondary" disabled={!canDecide || busy} onClick={() => decide("inconclusive")}>
                            Inconclusive
                          </Button>
                        </div>
                        {me?.role !== "reviewer" && <p className="text-sm text-muted-foreground">Only a Cumulus ID with the reviewer role can record a decision.</p>}
                      </div>
                    )}
                    {detail.notes && <p className="text-sm">Recorded note: {detail.notes}</p>}
                    {receipt && <p className="rounded-md border border-primary/40 bg-primary/10 p-3 font-mono text-xs">{receipt}</p>}
                  </CardContent>
                </Card>
              )}
              {error && <p className="mt-3 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">{error}</p>}
            </section>
          </>
        )}
      </main>
      <footer className="app-footer">
        <FirmSuite product="eidetic" compact />
        Infinitum Corporation® · 1629 K Street NW, Suite 300, Washington, D.C. · 202-729-9509 · info@theinfinitumcorporation.com
        <span className="mt-1 block">Signed in with Cumulus ID. Templates never reach this desk.</span>
      </footer>
    </div>
  );
}
