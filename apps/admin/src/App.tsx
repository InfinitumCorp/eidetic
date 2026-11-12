// © Infinitum Corporation®. All rights reserved.
import { FirmSuite } from "./firm/FirmSuite";

import { useEffect, useState, type FormEvent } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@eidetic/ui";
import { CidAccount, CidSignIn } from "./CidSignIn";
import { cidToken, useCumulusId } from "./cid";

interface Me {
  id: string;
  displayName: string;
  role: string;
}

interface Purpose {
  code: string;
  title: string;
  description: string;
  edition: string;
  legalBases: string[];
  datasetIds: string[];
  allowedRoles: string[];
  active: boolean;
}

interface SubjectView {
  cid: string;
  displayName: string;
  status: "active" | "withdrawn";
  consents: Array<{ purposeCode: string; status: string; datasetIds: string[] }>;
  template: { present: boolean; quality: number | null };
}

interface AuditEntry {
  seq: number;
  action: string;
  hash: string;
  prevHash: string;
  attestation: { message?: string; matchRan?: boolean; code?: string };
}

interface Seam {
  system: string;
  status: string;
  summary: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${cidToken() ?? ""}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  return body as T;
}

export function App() {
  const [health, setHealth] = useState<"loading" | "up" | "down">("loading");
  const [edition, setEdition] = useState<string>("");
  const [purposes, setPurposes] = useState<Purpose[]>([]);
  const [subjects, setSubjects] = useState<SubjectView[]>([]);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [verify, setVerify] = useState<string>("Audit chain has not been checked this session.");
  const [seams, setSeams] = useState<Seam[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [biasNote, setBiasNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const { token } = useCumulusId();
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [form, setForm] = useState({ displayName: "Avery Quinn", fixtureId: "avery-quinn", purposeCode: "record_reconciliation" });

  async function reload() {
    const [purposeBody, subjectBody, auditBody, seamBody, editionBody] = await Promise.all([
      api<{ purposes: Purpose[] }>("/v1/purposes"),
      api<{ subjects: SubjectView[] }>("/v1/subjects"),
      api<{ entries: AuditEntry[] }>("/v1/audit"),
      api<{ seams: Seam[] }>("/v1/seams"),
      api<{ mil: { enabled: boolean; workflows: string; product: string } }>("/v1/edition"),
    ]);
    setPurposes(purposeBody.purposes);
    setSubjects(subjectBody.subjects);
    setEntries(auditBody.entries);
    setSeams(seamBody.seams);
    setEdition(`${editionBody.mil.product} flag ${editionBody.mil.enabled ? "on" : "off"} · ${editionBody.mil.workflows}`);
  }

  useEffect(() => {
    fetch("/v1/health")
      .then((response) => {
        if (!response.ok) throw new Error("down");
        setHealth("up");
      })
      .catch(() => setHealth("down"));
  }, []);

  useEffect(() => {
    setMe(null);
    setMeError(null);
    if (health !== "up" || !token) return;
    api<{ actor: Me }>("/v1/me")
      .then((body) => {
        if (body.actor.role !== "admin") throw new Error(`This Cumulus ID is a ${body.actor.role}. The purpose desk needs the admin role.`);
        setMe(body.actor);
      })
      .catch((reason: Error) => setMeError(reason.message));
  }, [health, token]);

  useEffect(() => {
    if (!me) return;
    reload().catch((reason: Error) => setError(reason.message));
  }, [me]);

  async function enroll(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/v1/subjects", {
        method: "POST",
        body: JSON.stringify({
          displayName: form.displayName,
          legalBasis: "consent",
          purposes: [{ purposeCode: form.purposeCode, datasetIds: form.purposeCode === "consented_assistance" ? ["personal_memory"] : form.purposeCode === "access_control" ? ["facility_access"] : ["workforce_records"] }],
          fixtureId: form.fixtureId,
          recordAttributes: { site: "Washington" },
        }),
      });
      await reload();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(subject: SubjectView) {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/subjects/${encodeURIComponent(subject.cid)}/withdraw`, { method: "POST", body: "{}" });
      setWithdrawing(null);
      await reload();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function checkChain() {
    setBusy(true);
    try {
      const proof = await api<{ ok: boolean; entries: number; head: string | null }>("/v1/audit/verify");
      setVerify(proof.ok ? `Chain intact across ${proof.entries} entries. Head ${proof.head ?? "empty"}.` : "Chain verification failed.");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runBias() {
    setBusy(true);
    setError(null);
    try {
      const report = await api<{ passesLocalThreshold: boolean; metrics: { demographic_parity_difference: number; equalized_odds_difference: number }; note: string }>(
        "/v1/bias/evaluations",
        {
          method: "POST",
          body: JSON.stringify({
            releaseId: "mvp-0",
            cases: [
              { id: "a1", group: "cohort-a", expectedCid: "cid://infinitum/one", predictedCid: "cid://infinitum/one", confidence: 0.9 },
              { id: "a2", group: "cohort-a", expectedCid: null, predictedCid: null, confidence: 0.1 },
              { id: "b1", group: "cohort-b", expectedCid: "cid://infinitum/one", predictedCid: null, confidence: 0.2 },
              { id: "b2", group: "cohort-b", expectedCid: null, predictedCid: "cid://infinitum/two", confidence: 0.4 },
            ],
          }),
        },
      );
      setBiasNote(
        `${report.note} Demographic parity difference ${report.metrics.demographic_parity_difference}. Equalized odds difference ${report.metrics.equalized_odds_difference}.`,
      );
      await reload();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="app-bar">
        <a className="app-wordmark" href="/">
          ei·det·ic<sup className="tm">™</sup>
        </a>
        <nav className="app-nav" aria-label="Main">
          <a href="/" aria-current="page">Purpose desk</a>
        </nav>
        <CidAccount />
      </header>
      <main id="main" className="app-main grid gap-4">
        <div className="app-head">
          <div>
            <h1>Purpose desk</h1>
            <p className="max-w-2xl">Publish purposes, record consent, and read the hash chain. Biometric templates stay in the sealed store.</p>
          </div>
        </div>
        {health === "loading" && <p className="text-muted-foreground">Checking the API…</p>}
        {health === "down" && (
          <Card>
            <CardContent className="pt-5">The API is not reachable. Start Postgres and <code className="font-mono">pnpm dev</code>, then reload.</CardContent>
          </Card>
        )}
        {health === "up" && !me && <CidSignIn desk="purpose desk" error={meError} signedIn={Boolean(token)} />}
        {health === "up" && me && (
          <>
            {error && <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">{error}</p>}
            <section className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Purposes</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {purposes.length === 0 && <p className="text-sm text-muted-foreground">No purposes published yet.</p>}
                  {purposes.map((purpose) => (
                    <div key={purpose.code} className="rounded-md border border-border p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{purpose.title}</span>
                        <Badge variant="outline">{purpose.edition}</Badge>
                      </div>
                      <p className="mt-1 text-muted-foreground">{purpose.description}</p>
                      <p className="mt-2 font-mono text-xs text-muted-foreground">
                        {purpose.code} · {purpose.legalBases.join(", ")} · {purpose.datasetIds.join(", ")}
                      </p>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Enroll a synthetic subject</CardTitle>
                </CardHeader>
                <CardContent>
                  <form className="space-y-3" onSubmit={enroll}>
                    <div>
                      <Label htmlFor="name">Display name</Label>
                      <Input id="name" value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
                    </div>
                    <div>
                      <Label htmlFor="fixture">Synthetic fixture</Label>
                      <Input id="fixture" value={form.fixtureId} onChange={(event) => setForm({ ...form, fixtureId: event.target.value })} />
                    </div>
                    <div>
                      <Label htmlFor="purpose">Purpose</Label>
                      <select
                        id="purpose"
                        className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3"
                        value={form.purposeCode}
                        onChange={(event) => setForm({ ...form, purposeCode: event.target.value })}
                      >
                        {purposes.map((purpose) => (
                          <option key={purpose.code} value={purpose.code}>
                            {purpose.title}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Button type="submit" disabled={busy}>
                      Record consent
                    </Button>
                  </form>
                </CardContent>
              </Card>
            </section>

            <Card>
              <CardHeader>
                <CardTitle>Consent ledger</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {subjects.length === 0 && <p className="text-sm text-muted-foreground">No one is enrolled. Consent is required before a search can run.</p>}
                {subjects.map((subject) => (
                  <div key={subject.cid} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
                    <div>
                      <p className="font-medium">{subject.displayName}</p>
                      <p className="font-mono text-xs text-muted-foreground">{subject.cid}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Template {subject.template.present ? "sealed" : "purged"} ·{" "}
                        {subject.consents.map((consent) => `${consent.purposeCode} ${consent.status}`).join(", ") || "no consent"}
                      </p>
                    </div>
                    {subject.status === "withdrawn" ? (
                      <Badge variant="danger">Withdrawn</Badge>
                    ) : withdrawing === subject.cid ? (
                      <div className="flex gap-2">
                        <Button variant="destructive" disabled={busy} onClick={() => withdraw(subject)}>
                          Purge template
                        </Button>
                        <Button variant="outline" onClick={() => setWithdrawing(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button variant="outline" onClick={() => setWithdrawing(subject.cid)}>
                        Withdraw consent
                      </Button>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>

            <section className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Audit chain</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">{verify}</p>
                  <Button variant="secondary" disabled={busy} onClick={checkChain}>
                    Verify hash chain
                  </Button>
                  <ul className="space-y-2 text-xs">
                    {entries.length === 0 && <li className="text-muted-foreground">The log is empty.</li>}
                    {entries.slice(-8).map((entry) => (
                      <li key={entry.seq} className="font-mono text-muted-foreground">
                        {entry.seq} {entry.action} {entry.hash.slice(0, 12)} · {entry.attestation.message}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Bias hook and boundaries</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="text-muted-foreground">{edition}. Military workflows are not implemented.</p>
                  <Button variant="outline" disabled={busy} onClick={runBias}>
                    Run sample cohort evaluation
                  </Button>
                  {biasNote && <p>{biasNote}</p>}
                  <ul className="space-y-2 text-muted-foreground">
                    {seams.map((seam) => (
                      <li key={seam.system}>
                        <span className="text-foreground">{seam.system}</span> · {seam.summary}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </section>
          </>
        )}
      </main>
      <footer className="app-footer">
        <FirmSuite product="eidetic" compact />
        Infinitum Corporation® · 1629 K Street NW, Suite 300, Washington, D.C. · 202-729-9509 · info@theinfinitumcorporation.com
      </footer>
    </div>
  );
}
