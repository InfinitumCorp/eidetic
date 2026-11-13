// © Infinitum Corporation®. All rights reserved.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button, Card, CardContent, Label } from "@eidetic/ui";

interface Purpose {
  code: string;
  title: string;
  edition: "civilian" | "business";
  legalBases: string[];
  datasetIds: string[];
  allowedRoles: string[];
  active: boolean;
}

interface SearchResult {
  reviewId: string;
  message: string;
  candidates: unknown[];
}

type Call = <T>(path: string, init?: RequestInit) => Promise<T>;

// Synthetic fixtures only. The API refuses fixture ids unless DEMO_MODE is on.
const FIXTURES = [
  { id: "avery-quinn", label: "Avery Quinn (synthetic)" },
  { id: "jordan-blake", label: "Jordan Blake (synthetic)" },
  { id: "casey-morgan", label: "Casey Morgan (synthetic)" },
];
const MAX_PROBE_BYTES = 512 * 1024;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("The image could not be read."));
    reader.readAsDataURL(file);
  });
}

/**
 * The operator's search form. The API decides whether the search may run (role, purpose, legal basis, consent,
 * rate limit). A search that runs lands on this desk as an unconfirmed review; it is never a match on its own.
 */
export function OperatorSearch({ call, role, demoMode, onQueued }: { call: Call; role: string; demoMode: boolean; onQueued: (reviewId: string) => void }) {
  const [purposes, setPurposes] = useState<Purpose[]>([]);
  const [purposeCode, setPurposeCode] = useState("");
  const [legalBasis, setLegalBasis] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [fixtureId, setFixtureId] = useState(demoMode ? FIXTURES[0].id : "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string; note?: string } | null>(null);

  useEffect(() => {
    call<{ purposes: Purpose[] }>("/v1/purposes")
      .then((body) => setPurposes(body.purposes.filter((purpose) => purpose.active && purpose.allowedRoles.includes(role))))
      .catch((reason: Error) => setOutcome({ ok: false, text: reason.message }));
  }, [call, role]);

  const purpose = useMemo(() => purposes.find((item) => item.code === purposeCode) ?? purposes[0], [purposes, purposeCode]);

  useEffect(() => {
    if (!purpose) return;
    setPurposeCode(purpose.code);
    setLegalBasis((current) => (purpose.legalBases.includes(current) ? current : purpose.legalBases[0] ?? ""));
    setDatasetId((current) => (purpose.datasetIds.includes(current) ? current : purpose.datasetIds[0] ?? ""));
  }, [purpose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!purpose) return;
    setOutcome(null);
    if (!fixtureId && !file) {
      setOutcome({ ok: false, text: "Choose a probe image first." });
      return;
    }
    if (file && file.size > MAX_PROBE_BYTES) {
      setOutcome({ ok: false, text: "The probe image must be 512 KB or smaller." });
      return;
    }
    setBusy(true);
    try {
      const probe = file ? { imageBase64: await readBase64(file) } : { fixtureId };
      const result = await call<SearchResult>("/v1/searches", {
        method: "POST",
        body: JSON.stringify({ purposeCode: purpose.code, legalBasis, datasetId, edition: purpose.edition, ...probe }),
      });
      const waiting = result.candidates.length;
      setOutcome({
        ok: true,
        text: result.message,
        note: waiting === 1 ? "1 candidate is waiting for a reviewer." : `${waiting} candidates are waiting for a reviewer.`,
      });
      onQueued(result.reviewId);
    } catch (reason) {
      // Refusals from the API already say whether the match ran.
      setOutcome({ ok: false, text: (reason as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (purposes.length === 0) {
    return (
      <Card>
        <CardContent className="pt-5 text-sm text-muted-foreground">No active purpose lets your role search. An admin publishes purposes on the purpose desk.</CardContent>
      </Card>
    );
  }

  const selectClass = "mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
  return (
    <Card>
      <CardContent className="pt-5">
        <form className="space-y-3" onSubmit={submit}>
          <h2 className="font-medium">Run a search</h2>
          <p className="text-xs text-muted-foreground">It runs only if the purpose, legal basis and the person's consent all allow it. Every attempt is audited.</p>
          <div>
            <Label htmlFor="search-purpose">Purpose</Label>
            <select id="search-purpose" className={selectClass} value={purpose?.code ?? ""} onChange={(event) => setPurposeCode(event.target.value)}>
              {purposes.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.title}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="search-basis">Legal basis</Label>
              <select id="search-basis" className={selectClass} value={legalBasis} onChange={(event) => setLegalBasis(event.target.value)}>
                {purpose?.legalBases.map((basis) => (
                  <option key={basis} value={basis}>
                    {basis}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="search-dataset">Dataset</Label>
              <select id="search-dataset" className={selectClass} value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
                {purpose?.datasetIds.map((dataset) => (
                  <option key={dataset} value={dataset}>
                    {dataset}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {demoMode && (
            <div>
              <Label htmlFor="search-fixture">Synthetic probe</Label>
              <select
                id="search-fixture"
                className={selectClass}
                value={fixtureId}
                disabled={Boolean(file)}
                onChange={(event) => setFixtureId(event.target.value)}
              >
                <option value="">None, use an image</option>
                {FIXTURES.map((fixture) => (
                  <option key={fixture.id} value={fixture.id}>
                    {fixture.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <Label htmlFor="search-image">Probe image (512 KB max)</Label>
            <input
              id="search-image"
              type="file"
              accept="image/*"
              className="mt-1 block w-full text-sm"
              onChange={(event) => {
                const next = event.target.files?.[0] ?? null;
                setFile(next);
                if (next) setFixtureId("");
              }}
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Searching…" : "Search"}
          </Button>
          {outcome && (
            <p role="status" className={`text-sm ${outcome.ok ? "text-muted-foreground" : "text-destructive"}`}>
              {outcome.text}
              {outcome.note && <> <span>{outcome.note}</span></>}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
