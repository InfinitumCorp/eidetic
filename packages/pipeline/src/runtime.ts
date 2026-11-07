// © Infinitum Corporation®. All rights reserved.

import { randomUUID } from "node:crypto";
import { LocalTrillianCheckpointPort } from "@eidetic/audit";
import { LocalFidesConsentPort } from "@eidetic/consent";
import { LocalPatternRedactor, type TextRedactor } from "@eidetic/contracts";
import { MemoryBiometricStore, MockMatcher, type MatcherAdapter } from "@eidetic/matcher";
import { LocalPolicyDecider, type PolicyDecider } from "@eidetic/policy";
import { MemoryDatabase } from "./memory.js";
import type { Repositories } from "./repositories.js";
import { EideticService, type IdFactory } from "./service.js";

export function createIdFactory(): IdFactory {
  return {
    id: (prefix) => `${prefix}_${randomUUID().replace(/-/g, "")}`,
    cid: () => `cid://infinitum/${randomUUID().replace(/-/g, "")}`,
  };
}

export function createMemoryRuntime(options: {
  milEnabled?: boolean;
  now?: () => Date;
  policy?: PolicyDecider;
  matcher?: MatcherAdapter;
  redactor?: TextRedactor;
} = {}): { db: MemoryDatabase; repos: Repositories; service: EideticService; matcher: MatcherAdapter } {
  const db = new MemoryDatabase();
  const matcher = options.matcher ?? new MockMatcher(new MemoryBiometricStore());
  const service = new EideticService({
    repos: db.repos,
    transaction: (fn) => db.transaction(fn),
    matcher,
    policy: options.policy ?? new LocalPolicyDecider(),
    redactor: options.redactor ?? new LocalPatternRedactor(),
    fides: new LocalFidesConsentPort(),
    trillian: new LocalTrillianCheckpointPort(),
    milEnabled: options.milEnabled ?? false,
    now: options.now ?? (() => new Date("2026-11-07T12:00:00.000Z")),
    ids: createIdFactory(),
  });
  return { db, repos: db.repos, service, matcher };
}
