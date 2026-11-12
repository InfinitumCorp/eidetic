// © Infinitum Corporation®. All rights reserved.
import { useEffect, useRef } from "react";
import { Button, Card, CardContent } from "@eidetic/ui";
import { createCumulusId, signIn, signOut, type CidProfile } from "./cid";

const HEADINGS = {
  purpose: "Sign in to the purpose desk",
  review: "Sign in to the review desk",
} as const;

/** The desk's only sign-in: Cumulus ID, with "Create a Cumulus ID" in the same flow. */
export function CidSignIn({ desk, error, signedIn }: { desk: keyof typeof HEADINGS; error?: string | null; signedIn?: boolean }) {
  return (
    <Card className="max-w-xl">
      <CardContent className="grid gap-4 pt-5">
        <div>
          <h2 className="text-lg font-semibold">{HEADINGS[desk]}</h2>
          <p className="text-sm text-muted-foreground">
            Use your Cumulus ID. No Cumulus ID yet? Create one here and you come straight back, signed in.
          </p>
        </div>
        {error && (
          <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {signedIn ? (
            <Button type="button" variant="outline" onClick={signOut}>
              Sign out
            </Button>
          ) : (
            <>
              <Button type="button" onClick={signIn}>
                Sign in with Cumulus ID
              </Button>
              <Button type="button" variant="outline" onClick={createCumulusId}>
                Create a Cumulus ID
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The Cumulus://ID account bar at the right of the app bar: the same sign-in, account menu and
 * product launcher as every Infinitum product. /cumulus-bar.js renders into this element; it ran
 * before React mounted the header, so ask it to render again once the element exists.
 */
export function CidAccount() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current && !ref.current.shadowRoot) window.CumulusBar?.setProfile(null);
  }, []);
  // "Create a Cumulus ID" stays on the sign-in card below; the bar keeps to one button so the
  // header fits at 390px.
  return <div ref={ref} className="app-actions" data-cumulus-bar="" data-create="false" />;
}
