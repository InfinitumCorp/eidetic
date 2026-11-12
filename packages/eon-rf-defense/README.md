# @eidetic/eon-rf-defense

**Defensive PNT (position / navigation / timing) integrity for EON.**

This package detects **GNSS jamming and spoofing attacks against EON's own
receivers**, using telemetry the receiver already produces, and recommends a
safe fallback. It is deliberately scoped the same way as `@eidetic/geo` and
`@eidetic/mil`: a capability with a hard boundary that **fails closed**.

## Scope

| Allowed (this package)                                   | Refused (out of scope)                               |
| -------------------------------------------------------- | ---------------------------------------------------- |
| Read EON's own receiver telemetry (C/N0, AGC, fix, clock)| Transmitting anything on any band                    |
| Score it for jamming / spoofing indicators               | Jamming, spoofing, or deauth of any system           |
| Recommend trust state + inertial fallback                | Intercepting / decoding a third party's comms (SIGINT)|
| Generate **synthetic numeric** telemetry for tests       | Any RF emission or antenna I/O                        |

There is **no transmit path and no interception path** in this package, by
design. `assertDefensiveOnly()` throws `EideticError("FORBIDDEN", …)` on any
request naming an offensive or intercept action, so the boundary is enforced in
code, not just documented.

## What it does

- **`detectSpoofing(epoch, previous?, config?)`** — consensus of spoof
  fingerprints: uniform/elevated C/N0, physically impossible position jumps,
  receiver-clock discontinuities, and collapsed Doppler diversity.
- **`constellationDisagreement(fixA, fixB, config?)`** — cross-checks two
  independently computed fixes (e.g. GPS-only vs Galileo-only); a spoof that
  targets one constellation drives them apart.
- **`detectJamming(epoch, previous?, config?)`** — AGC saturation, noise-floor
  rise, C/N0 collapse, and sudden loss of lock.
- **`PntIntegrityMonitor`** — folds both detectors into a `TRUSTED → DEGRADED →
  DENIED` trust state with hysteresis, and emits a recommendation
  (`USE_GNSS` / `BLEND_WITH_INERTIAL` / `FALLBACK_INERTIAL_DEAD_RECKONING`).
- **`nominalScenario` / `spoofedScenario` / `jammedScenario`** — deterministic,
  seeded, **numbers-only** generators for regression-testing the detectors
  without a live sky or a test range.

## Usage

```ts
import { PntIntegrityMonitor } from "@eidetic/eon-rf-defense";

const monitor = new PntIntegrityMonitor();
for (const epoch of receiverEpochStream) {       // your own receiver's telemetry
  const a = monitor.assess(epoch);
  if (a.state === "DENIED") {
    engageInertialFallback();                     // stop trusting GNSS
    log.warn(a.summary);
  }
}
```

## What this is NOT

It is **not** electronic warfare, **not** a jammer or spoofer, and **not** a
SIGINT/COMINT/ELINT collection system. Those were requested and declined; this
is the defensive counterpart that was built instead. If a future requirement
needs genuine RF emission or interception, that belongs in a separate,
appropriately authorised and reviewed system — not here.

© Infinitum Corporation®. All rights reserved.
