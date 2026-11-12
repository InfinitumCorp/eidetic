// © Infinitum Corporation®. All rights reserved.
//
// Subscriptions and tiers, paid through Stripe via the Infinitum revenue API. The app never holds a
// Stripe key: it sends the signed-in user's Cumulus ID token to the revenue API, which returns a
// Stripe Checkout or customer-portal URL to open. Not shown on MIL deployments.

import { useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@eidetic/ui";
import { cidToken } from "./cid";

const REVENUE_URL = String(import.meta.env.VITE_REVENUE_URL || "https://infinitum-revenue.infinitumcorp.workers.dev").replace(/\/+$/, "");
const PRODUCT = "eidetic";

export interface Plan {
  id: string;
  product: string;
  name: string;
  channel: "self_serve" | "sales_assisted" | "contract";
  priceCents: number;
  interval: "month" | "year";
  perSeat: boolean;
  included: Record<string, number>;
  features: string[];
  trialDays?: number;
}

interface Entitlement {
  product: string;
  plan: string;
  status: string;
}

async function revenue<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${REVENUE_URL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${cidToken() ?? ""}`, ...(init?.body ? { "content-type": "application/json" } : {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? `Billing request failed (${response.status})`);
  return body as T;
}

export const formatPrice = (p: Pick<Plan, "priceCents" | "interval" | "perSeat">) =>
  p.priceCents === 0
    ? "Free"
    : `$${(p.priceCents / 100).toLocaleString("en-US", { minimumFractionDigits: p.priceCents % 100 ? 2 : 0 })} / ${p.interval}${p.perSeat ? " per seat" : ""}`;

const returnUrl = () => `${window.location.origin}${window.location.pathname}`;

export function Billing({ signedIn }: { signedIn: boolean }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [current, setCurrent] = useState<Entitlement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice] = useState<string | null>(() => {
    const q = new URLSearchParams(window.location.search);
    return q.get("billing") === "success" ? "Payment complete. Your plan is active." : q.get("billing") === "cancelled" ? "Checkout cancelled. No charge was made." : null;
  });

  useEffect(() => {
    fetch(`${REVENUE_URL}/v1/catalog`)
      .then((r) => r.json())
      .then((c: { plans: Plan[] }) => setPlans(c.plans.filter((p) => p.product === PRODUCT && p.channel !== "contract")))
      .catch(() => setError("Plans could not be loaded."));
  }, []);

  useEffect(() => {
    if (!signedIn) return setCurrent(null);
    revenue<{ products: Entitlement[] }>("/v1/me/entitlements")
      .then((e) => setCurrent(e.products.find((p) => p.product === PRODUCT) ?? null))
      .catch((e: Error) => setError(e.message));
  }, [signedIn]);

  async function go(key: string, path: string, payload: Record<string, unknown>) {
    setBusy(key);
    setError(null);
    try {
      const { url } = await revenue<{ url: string }>(path, { method: "POST", body: JSON.stringify({ ...payload, returnUrl: returnUrl() }) });
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plan and billing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {notice && <p>{notice}</p>}
        {current && (
          <p>
            Current plan: <span className="text-foreground">{plans.find((p) => p.id === current.plan)?.name ?? current.plan}</span>{" "}
            <Badge variant="outline">{current.status}</Badge>
          </p>
        )}
        <ul className="space-y-3">
          {plans.map((plan) => (
            <li key={plan.id} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-foreground">{plan.name}</span>
                <span className="text-muted-foreground">{formatPrice(plan)}</span>
                {plan.channel === "sales_assisted" && <Badge variant="outline">Approved organisations</Badge>}
              </div>
              <Button
                size="sm"
                disabled={!signedIn || busy !== null || current?.plan === plan.id}
                onClick={() => go(plan.id, "/v1/subscriptions/checkout", { planId: plan.id })}
              >
                {current?.plan === plan.id ? "Current plan" : busy === plan.id ? "Opening checkout…" : "Subscribe"}
              </Button>
            </li>
          ))}
        </ul>
        <Button variant="outline" size="sm" disabled={!signedIn || busy !== null} onClick={() => go("portal", "/v1/billing/portal", {})}>
          Manage billing
        </Button>
        {!signedIn && <p className="text-muted-foreground">Sign in with Cumulus ID to subscribe.</p>}
        <p className="text-muted-foreground">
          Plans for approved organisations open checkout after Infinitum clears your organisation's purpose review.
        </p>
        {error && <p className="text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
