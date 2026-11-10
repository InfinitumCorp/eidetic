// © Infinitum Corporation®. All rights reserved.

/**
 * Privacy-first Amplitude bootstrap for ei·det·ic desks.
 * Public API key only. Never identify a user. Never send face, image,
 * match, or identity data. Page views are redacted to a static desk name.
 */
import { add, init } from "@amplitude/analytics-browser";
import { redactEideticEvent } from "./redact";

export { redactEideticEvent } from "./redact";

const PUBLIC_API_KEY = "756c0bc80c5cb27386bfd7b2b13196c8";

export type EideticDesk = "purpose-desk" | "review-desk";

export function initEideticAmplitude(pageName: EideticDesk): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __infinitumAmplitudeStarted?: boolean };
  if (w.__infinitumAmplitudeStarted) return;
  const env = (import.meta as { env?: { VITE_AMPLITUDE_API_KEY?: string } }).env;
  const apiKey = env?.VITE_AMPLITUDE_API_KEY || PUBLIC_API_KEY;
  if (!apiKey || apiKey.length < 16) return;
  w.__infinitumAmplitudeStarted = true;

  void add({
    name: "eidetic-redact",
    type: "enrichment",
    setup: async () => undefined,
    execute: async (event) => redactEideticEvent(event, pageName),
  });

  init(apiKey, {
    autocapture: {
      attribution: false,
      fileDownloads: false,
      formInteractions: false,
      pageViews: true,
      sessions: true,
      elementInteractions: false,
      frustrationInteractions: false,
      networkTracking: false,
      webVitals: false,
      performanceTracking: false,
      pageUrlEnrichment: false,
    },
    trackingOptions: { ipAddress: false },
    serverZone: "US",
    fetchRemoteConfig: false,
    remoteConfig: { fetchRemoteConfig: false },
    enableDiagnostics: false,
  });
}
