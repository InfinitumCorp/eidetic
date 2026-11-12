// © Infinitum Corporation®. All rights reserved.
import { FirmSuite } from "./firm/FirmSuite";

import { useEffect, useState, type FormEvent } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, RavenMark } from "@eidetic/ui";
import { CidAccount, CidSignIn } from "./CidSignIn";
import { cidToken, useCumulusId } from "./cid";
import { Billing } from "./Billing";

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
  consents: Array<{ purposeCode: string; status: string; datasetIds: string[]; expiresAt?: string | null; expired?: boolean }>;
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

interface GeoRoutingView {
  geoRouting: boolean;
  processOptIn: boolean;
  active: boolean;
  identityMatch: false;
}

const LEGAL_BASIS_OPTIONS = ["consent", "contract", "legal_obligation"] as const;
const ROLE_OPTIONS = ["operator", "reviewer", "admin", "auditor"] as const;
const EMPTY_PURPOSE = {
  code: "",
  title: "",
  description: "",
  edition: "business",
  legalBases: ["consent"] as string[],
  datasets: "",
  allowedRoles: ["operator"] as string[],
};

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
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
  const [milEnabled, setMilEnabled] = useState(true); // billing stays hidden until the API says this is not a MIL deployment
  const [purposes, setPurposes] = useState<Purpose[]>([]);
  const [subjects, setSubjects] = useState<SubjectView[]>([]);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [olderThan, setOlderThan] = useState<number | null>(null);
  const [verify, setVerify] = useState<string>("Audit chain has not been checked this session.");
  const [seams, setSeams] = useState<Seam[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [biasNote, setBiasNote] = useState<string | null>(null);
  const [geoRouting, setGeoRouting] = useState<GeoRoutingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [draft, setDraft] = useState<typeof EMPTY_PURPOSE | null>(null);
  const { token } = useCumulusId();
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [form, setForm] = useState({ displayName: "Avery Quinn", fixtureId: "avery-quinn", purposeCode: "record_reconciliation", validDays: "0" });

  async function reload() {
    const [purposeBody, subjectBody, auditBody, seamBody, editionBody] = await Promise.all([
      api<{ purposes: Purpose[] }>("/v1/purposes"),
      api<{ subjects: SubjectView[] }>("/v1/subjects"),
      api<{ entries: AuditEntry[]; nextBefore: number | null }>("/v1/audit?limit=8"),
      api<{ seams: Seam[] }>("/v1/seams"),
      api<{ mil: { enabled: boolean; workflows: string; product: string } }>("/v1/edition"),
    ]);
    setPurposes(purposeBody.purposes);
    setSubjects(subjectBody.subjects);
    setEntries(auditBody.entries);
    setOlderThan(auditBody.nextBefore);
    setSeams(seamBody.seams);
    setMilEnabled(editionBody.mil.enabled);
    setEdition(`${editionBody.mil.product} flag ${editionBody.mil.enabled ? "on" : "off"} · ${editionBody.mil.workflows}`);
    try {
      setGeoRouting(await api<GeoRoutingView>("/v1/settings/geo-routing"));
    } catch {
      setGeoRouting({ geoRouting: false, processOptIn: false, active: false, identityMatch: false });
    }
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
          purposes: [
            {
              purposeCode: form.purposeCode,
              // Consent covers the datasets the purpose was published with.
              datasetIds: purposes.find((purpose) => purpose.code === form.purposeCode)?.datasetIds ?? [],
              // "0" means the consent lasts until the subject withdraws it.
              expiresAt: form.validDays === "0" ? undefined : new Date(Date.now() + Number(form.validDays) * 86_400_000).toISOString(),
            },
          ],
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

  // Publish a new purpose, or retire / reinstate one. The API validates codes and scope and audits each change.
  async function savePurpose(purpose: Purpose) {
    setBusy(true);
    setError(null);
    try {
      await api("/v1/purposes", { method: "POST", body: JSON.stringify(purpose) });
      await reload();
      return true;
    } catch (reason) {
      setError((reason as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function publishDraft(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const datasetIds = draft.datasets.split(",").map((item) => item.trim()).filter(Boolean);
    const saved = await savePurpose({
      code: draft.code.trim(),
      title: draft.title.trim(),
      description: draft.description.trim(),
      edition: draft.edition,
      legalBases: draft.legalBases,
      datasetIds,
      allowedRoles: draft.allowedRoles,
      active: true,
    });
    if (saved) setDraft(null);
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

  async function loadOlder() {
    if (olderThan === null) return;
    setBusy(true);
    try {
      const page = await api<{ entries: AuditEntry[]; nextBefore: number | null }>(`/v1/audit?limit=20&before=${olderThan}`);
      setEntries((current) => [...current, ...page.entries]);
      setOlderThan(page.nextBefore);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Subject access request: download one person's consents and audit activity as JSON. The API audits the export.
  async function downloadAccessReport(subject: SubjectView) {
    setBusy(true);
    setError(null);
    try {
      const report = await api<unknown>(`/v1/subjects/${encodeURIComponent(subject.cid)}/access-report`);
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `access-report-${subject.cid.replace("cid://infinitum/", "")}.json`;
      link.click();
      URL.revokeObjectURL(url);
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

  async function toggleGeoRouting() {
    if (!geoRouting) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api<GeoRoutingView>("/v1/settings/geo-routing", {
        method: "PUT",
        body: JSON.stringify({ geoRouting: !geoRouting.geoRouting }),
      });
      setGeoRouting(next);
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
          <RavenMark className="raven-mark" />
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
        {health === "up" && !me && (
          <CidSignIn desk="purpose" error={meError} signedIn={Boolean(token)} />
        )}
        {health === "up" && me && (
          <>
            {error && <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">{error}</p>}
            <section className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <CardTitle>Purposes</CardTitle>
                    {!draft && (
                      <Button variant="outline" disabled={busy} onClick={() => setDraft({ ...EMPTY_PURPOSE })}>
                        Publish a purpose
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {purposes.length === 0 && <p className="text-sm text-muted-foreground">No purposes published yet.</p>}
                  {purposes.map((purpose) => (
                    <div key={purpose.code} className="rounded-md border border-border p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{purpose.title}</span>
                        <span className="flex items-center gap-2">
                          {!purpose.active && <Badge variant="danger">Retired</Badge>}
                          <Badge variant="outline">{purpose.edition}</Badge>
                        </span>
                      </div>
                      <p className="mt-1 text-muted-foreground">{purpose.description}</p>
                      <p className="mt-2 font-mono text-xs text-muted-foreground">
                        {purpose.code} · {purpose.legalBases.join(", ")} · {purpose.datasetIds.join(", ")} · {purpose.allowedRoles.join(", ")}
                      </p>
                      <div className="mt-2">
                        <Button variant="outline" disabled={busy} onClick={() => savePurpose({ ...purpose, active: !purpose.active })}>
                          {purpose.active ? "Retire" : "Reinstate"}
                        </Button>
                      </div>
                    </div>
                  ))}
                  {draft && (
                    <form className="space-y-3 rounded-md border border-border p-3" onSubmit={publishDraft}>
                      <div>
                        <Label htmlFor="purpose-code">Code</Label>
                        <Input
                          id="purpose-code"
                          placeholder="visitor_check_in"
                          value={draft.code}
                          onChange={(event) => setDraft({ ...draft, code: event.target.value })}
                        />
                      </div>
                      <div>
                        <Label htmlFor="purpose-title">Title</Label>
                        <Input id="purpose-title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
                      </div>
                      <div>
                        <Label htmlFor="purpose-description">What it is for</Label>
                        <Input
                          id="purpose-description"
                          value={draft.description}
                          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                        />
                      </div>
                      <div>
                        <Label htmlFor="purpose-edition">Edition</Label>
                        <select
                          id="purpose-edition"
                          className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3"
                          value={draft.edition}
                          onChange={(event) => setDraft({ ...draft, edition: event.target.value })}
                        >
                          <option value="business">Business</option>
                          <option value="civilian">Civilian</option>
                        </select>
                      </div>
                      <div>
                        <Label htmlFor="purpose-datasets">Datasets (comma-separated codes)</Label>
                        <Input
                          id="purpose-datasets"
                          placeholder="visitor_log"
                          value={draft.datasets}
                          onChange={(event) => setDraft({ ...draft, datasets: event.target.value })}
                        />
                      </div>
                      <fieldset>
                        <legend className="text-sm font-medium">Legal bases</legend>
                        <div className="mt-1 flex flex-wrap gap-3 text-sm">
                          {LEGAL_BASIS_OPTIONS.map((basis) => (
                            <label key={basis} className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={draft.legalBases.includes(basis)}
                                onChange={() => setDraft({ ...draft, legalBases: toggle(draft.legalBases, basis) })}
                              />
                              {basis}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <fieldset>
                        <legend className="text-sm font-medium">Roles that may search</legend>
                        <div className="mt-1 flex flex-wrap gap-3 text-sm">
                          {ROLE_OPTIONS.map((role) => (
                            <label key={role} className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={draft.allowedRoles.includes(role)}
                                onChange={() => setDraft({ ...draft, allowedRoles: toggle(draft.allowedRoles, role) })}
                              />
                              {role}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <div className="flex gap-2">
                        <Button type="submit" disabled={busy}>
                          Publish
                        </Button>
                        <Button type="button" variant="outline" onClick={() => setDraft(null)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  )}
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
                        {purposes.filter((purpose) => purpose.active).map((purpose) => (
                          <option key={purpose.code} value={purpose.code}>
                            {purpose.title}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label htmlFor="valid">Consent lasts</Label>
                      <select
                        id="valid"
                        className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3"
                        value={form.validDays}
                        onChange={(event) => setForm({ ...form, validDays: event.target.value })}
                      >
                        <option value="0">Until withdrawn</option>
                        <option value="30">For 30 days</option>
                        <option value="90">For 90 days</option>
                        <option value="365">For 1 year</option>
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
                        {/* Each piece is its own text node so the language menu can translate it. */}
                        <span>{subject.template.present ? "Template sealed" : "Template purged"}</span>
                        <span> · </span>
                        {subject.consents.length === 0 ? (
                          <span>No consent</span>
                        ) : (
                          subject.consents.map((consent, index) => (
                            <span key={`${consent.purposeCode}-${index}`}>
                              {index > 0 && <span>, </span>}
                              <span>
                                {consent.expired
                                  ? `${consent.purposeCode} expired`
                                  : consent.status === "withdrawn"
                                    ? `${consent.purposeCode} withdrawn`
                                    : consent.expiresAt
                                      ? `${consent.purposeCode} granted until ${consent.expiresAt.slice(0, 10)}`
                                      : `${consent.purposeCode} granted`}
                              </span>
                            </span>
                          ))
                        )}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" disabled={busy} onClick={() => downloadAccessReport(subject)}>
                      Access report
                    </Button>
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
                    {entries.map((entry) => (
                      <li key={entry.seq} className="font-mono text-muted-foreground">
                        {entry.seq} {entry.action} {entry.hash.slice(0, 12)} · {entry.attestation.message}
                      </li>
                    ))}
                  </ul>
                  {olderThan !== null && (
                    <Button variant="outline" disabled={busy} onClick={loadOlder}>
                      Load older entries
                    </Button>
                  )}
                </CardContent>
              </Card>
              {!milEnabled && <Billing signedIn={Boolean(token)} />}
              <Card>
                <CardHeader>
                  <CardTitle>Bias hook and boundaries</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="text-muted-foreground">{edition}. Military workflows are not implemented.</p>
                  <div className="rounded-md border border-border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="geo-routing">Geo routing</Label>
                      <Button
                        id="geo-routing"
                        type="button"
                        variant={geoRouting?.geoRouting ? "secondary" : "outline"}
                        aria-pressed={geoRouting?.geoRouting ?? false}
                        disabled={busy || !geoRouting}
                        onClick={() => void toggleGeoRouting()}
                      >
                        {geoRouting?.geoRouting ? "On" : "Off"}
                      </Button>
                    </div>
                    <p className="mt-2 text-muted-foreground">
                      Default off. Country and site-category labels for cyber routing. Not used for identity matching.
                      {geoRouting && !geoRouting.processOptIn ? " INFINITUM_GEO_ENABLED is off, so the hook stays inactive." : ""}
                      {geoRouting?.active ? " The hook is active for routing labels only." : ""}
                    </p>
                  </div>
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
