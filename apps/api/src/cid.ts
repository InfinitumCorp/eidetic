// © Infinitum Corporation®. All rights reserved.
//
// People sign in to the purpose and review desks with Cumulus ID (id.cumuluscloud.app).
// The desks send the Cumulus ID access token as a bearer. This module checks it at the
// issuer (GET /api/id/userinfo) and maps the Cumulus ID to one ei·det·ic™ role from config:
//
//   CID_ADMINS, CID_OPERATORS, CID_REVIEWERS, CID_AUDITORS   comma or space separated CIDs
//
// A verified Cumulus ID that is on none of those lists gets no role. CID_ISSUER is configurable
// so a mirror that loads in Russia can be used; CID_ISSUER_MIRROR is tried only when the main
// issuer cannot be reached.

import { createHash, randomUUID } from "node:crypto";
import { ROLES, type Actor, type Role } from "@eidetic/contracts";

export const DEFAULT_CID_ISSUER = "https://id.cumuluscloud.app";

export interface CidConfig {
  issuers: string[];
  roles: Map<string, Role>;
}

export interface CidProfile {
  cid: string;
  username?: string;
  email?: string;
  name?: string;
  handle?: string;
}

export type CidResult = { actor: Actor; profile: CidProfile } | { noRole: CidProfile } | null;

const ROLE_ENV: Record<Role, string> = {
  admin: "CID_ADMINS",
  operator: "CID_OPERATORS",
  reviewer: "CID_REVIEWERS",
  auditor: "CID_AUDITORS",
};

const trimSlash = (value: string) => value.trim().replace(/\/+$/, "");

export function readCidConfig(env: NodeJS.ProcessEnv = process.env): CidConfig {
  const issuers = [env.CID_ISSUER?.trim() || DEFAULT_CID_ISSUER, env.CID_ISSUER_MIRROR?.trim() || ""]
    .filter(Boolean)
    .map(trimSlash);
  const roles = new Map<string, Role>();
  // Earlier roles win when one CID is listed twice, so admin beats the others.
  for (const role of ROLES) {
    for (const cid of (env[ROLE_ENV[role]] ?? "").split(/[\s,]+/)) {
      const key = cid.trim().toLowerCase();
      if (key && !roles.has(key)) roles.set(key, role);
    }
  }
  return { issuers: [...new Set(issuers)], roles };
}

export const cidActorId = (cid: string) => `cid:${cid.toLowerCase()}`;

/** One actor row per configured CID, so non-demo startups have somebody to seed. */
export function cidActorSeeds(config: CidConfig) {
  return [...config.roles].map(([cid, role]) => ({
    id: cidActorId(cid),
    displayName: cid,
    role,
    // Never used to sign in: CID actors authenticate at the issuer, not with a local token.
    token: `unusable-${randomUUID()}`,
  }));
}

interface Cached {
  result: CidResult;
  until: number;
}

export interface CidVerifierOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  cacheMs?: number;
  timeoutMs?: number;
}

/** Returns a function that turns a bearer token into an actor, a known-but-unlisted CID, or null. */
export function createCidVerifier(config: CidConfig, options: CidVerifierOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const cache = new Map<string, Cached>();

  async function userinfo(token: string): Promise<CidProfile | null> {
    for (const issuer of config.issuers) {
      let response: Response;
      try {
        response = await fetchImpl(`${issuer}/api/id/userinfo`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        continue; // Unreachable: try the mirror.
      }
      if (response.status >= 500) continue;
      if (!response.ok) return null;
      const body = (await response.json().catch(() => null)) as Partial<CidProfile> | null;
      if (!body || typeof body.cid !== "string" || !body.cid) return null;
      return body as CidProfile;
    }
    return null;
  }

  return async function verify(token: string): Promise<CidResult> {
    if (!token || token.length > 8000) return null;
    const key = createHash("sha256").update(token).digest("hex");
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.result;
    const profile = await userinfo(token);
    let result: CidResult = null;
    if (profile) {
      const role = config.roles.get(profile.cid.toLowerCase());
      result = role
        ? {
            profile,
            actor: { id: cidActorId(profile.cid), displayName: profile.username || profile.name || profile.email || profile.cid, role },
          }
        : { noRole: profile };
    }
    // Failures are not cached, so a restored issuer is picked up on the next request.
    if (result) {
      if (cache.size > 1000) cache.clear();
      cache.set(key, { result, until: now() + cacheMs });
    }
    return result;
  };
}
