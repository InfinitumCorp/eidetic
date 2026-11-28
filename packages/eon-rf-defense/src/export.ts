// © Infinitum Corporation®. All rights reserved.

import type { RunReport } from "./analyze.js";
import type { PntAssessment } from "./pnt.js";

/**
 * Serialise an after-action RunReport for mission logs / downstream analysis.
 *
 * Two formats: NDJSON (one assessment per line, loss-less for pipelines) and
 * CSV (one row per epoch, for spreadsheets / quick triage). Pure string
 * formatting of EON's own analysis output — no RF, no I/O.
 */

export interface ExportRow {
  t_ms: number;
  state: PntAssessment["state"];
  recommendation: PntAssessment["recommendation"];
  spoof_confidence: number;
  jam_confidence: number;
  summary: string;
}

function toRow(a: PntAssessment): ExportRow {
  return {
    t_ms: a.t_ms,
    state: a.state,
    recommendation: a.recommendation,
    spoof_confidence: round3(a.spoofing.confidence),
    jam_confidence: round3(a.jamming.confidence),
    summary: a.summary,
  };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** NDJSON: one JSON object per line, in epoch order. */
export function toNdjson(report: RunReport): string {
  return report.timeline.map((a) => JSON.stringify(toRow(a))).join("\n");
}

const CSV_COLUMNS: (keyof ExportRow)[] = [
  "t_ms",
  "state",
  "recommendation",
  "spoof_confidence",
  "jam_confidence",
  "summary",
];

function csvEscape(value: string | number): string {
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** CSV with a header row; summary is quoted/escaped per RFC 4180. */
export function toCsv(report: RunReport): string {
  const header = CSV_COLUMNS.join(",");
  const rows = report.timeline.map((a) => {
    const row = toRow(a);
    return CSV_COLUMNS.map((c) => csvEscape(row[c])).join(",");
  });
  return [header, ...rows].join("\n");
}

/** A compact one-line digest suitable for an alert or log header. */
export function digestLine(report: RunReport): string {
  return (
    `[EON-PNT] epochs=${report.epochs} span=${report.span_ms}ms ` +
    `threat=${report.leadingThreat} ` +
    `firstUntrusted=${report.firstUntrustedAt_ms ?? "-"} ` +
    `firstDenied=${report.firstDeniedAt_ms ?? "-"} ` +
    `peakSpoof=${round3(report.peakSpoofConfidence)} ` +
    `peakJam=${round3(report.peakJamConfidence)}`
  );
}
