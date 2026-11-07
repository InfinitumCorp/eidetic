// © Infinitum Corporation®. All rights reserved.

import { EideticError } from "@eidetic/contracts";

export interface EvaluationCase {
  id: string;
  /** Cohort key supplied by the evaluation designer. Never inferred from a face. */
  group: string;
  expectedCid: string | null;
  predictedCid: string | null;
  confidence: number;
}

export interface GroupMetrics {
  count: number;
  accuracy: number;
  selectionRate: number;
  truePositiveRate: number | null;
  falsePositiveRate: number | null;
}

export interface FairnessReport {
  releaseId: string;
  model: string;
  implementation: "local-typescript";
  fairlearn: "not_invoked";
  reference: "https://fairlearn.org/";
  groupsAreSuppliedLabels: true;
  inferredFromBiometrics: false;
  byGroup: Record<string, GroupMetrics>;
  metrics: {
    demographic_parity_difference: number;
    equalized_odds_difference: number;
  };
  passesLocalThreshold: boolean;
  threshold: { demographicParity: number; equalizedOdds: number };
  note: string;
}

export interface FairlearnBridge {
  evaluate(report: FairnessReport): Promise<FairnessReport>;
}

export class UnconfiguredFairlearnBridge implements FairlearnBridge {
  evaluate(_report: FairnessReport): Promise<FairnessReport> {
    return Promise.reject(
      new EideticError(
        "POLICY_UNAVAILABLE",
        "Fairlearn is an optional Python hook and is not invoked. The local TypeScript metrics are the MVP result.",
        501,
        false,
      ),
    );
  }
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function gap(values: Array<number | null>): number {
  const present = values.filter((value): value is number => value !== null);
  if (present.length < 2) return 0;
  return round4(Math.max(...present) - Math.min(...present));
}

export function evaluateFairness(input: { releaseId: string; model: string; cases: EvaluationCase[] }): FairnessReport {
  if (!/^[a-z0-9][a-z0-9._-]{1,64}$/.test(input.releaseId)) {
    throw new EideticError("VALIDATION", "Release id must be a short slug.", 422, false);
  }
  if (input.cases.length === 0 || input.cases.length > 500) {
    throw new EideticError("VALIDATION", "A bias evaluation needs between 1 and 500 labeled cases.", 422, false);
  }
  const groups = new Map<string, EvaluationCase[]>();
  for (const item of input.cases) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(item.group)) {
      throw new EideticError("VALIDATION", "Group labels are short cohort keys, not names or inferred demographics.", 422, false);
    }
    const list = groups.get(item.group) ?? [];
    list.push(item);
    groups.set(item.group, list);
  }
  const byGroup: Record<string, GroupMetrics> = {};
  for (const [group, cases] of groups) {
    const positives = cases.filter((item) => item.expectedCid !== null);
    const negatives = cases.filter((item) => item.expectedCid === null);
    const exact = cases.filter((item) => item.predictedCid === item.expectedCid).length;
    const selected = cases.filter((item) => item.predictedCid !== null).length;
    const truePositives = positives.filter((item) => item.predictedCid === item.expectedCid).length;
    const falsePositives = negatives.filter((item) => item.predictedCid !== null).length;
    byGroup[group] = {
      count: cases.length,
      accuracy: round4(exact / cases.length),
      selectionRate: round4(selected / cases.length),
      truePositiveRate: positives.length === 0 ? null : round4(truePositives / positives.length),
      falsePositiveRate: negatives.length === 0 ? null : round4(falsePositives / negatives.length),
    };
  }
  const metrics = {
    demographic_parity_difference: gap(Object.values(byGroup).map((group) => group.selectionRate)),
    equalized_odds_difference: Math.max(
      gap(Object.values(byGroup).map((group) => group.truePositiveRate)),
      gap(Object.values(byGroup).map((group) => group.falsePositiveRate)),
    ),
  };
  const threshold = { demographicParity: 0.1, equalizedOdds: 0.1 };
  const passes = metrics.demographic_parity_difference <= threshold.demographicParity && metrics.equalized_odds_difference <= threshold.equalizedOdds;
  return {
    releaseId: input.releaseId,
    model: input.model,
    implementation: "local-typescript",
    fairlearn: "not_invoked",
    reference: "https://fairlearn.org/",
    groupsAreSuppliedLabels: true,
    inferredFromBiometrics: false,
    byGroup,
    metrics,
    passesLocalThreshold: passes,
    threshold,
    note: passes
      ? "Within the local stub threshold. Publish the report with the release notes. This is not a certification."
      : "Local disparity threshold exceeded. Do not treat this release as cleared for a new dataset.",
  };
}
