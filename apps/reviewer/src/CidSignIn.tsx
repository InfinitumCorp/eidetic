// © Infinitum Corporation®. All rights reserved.
import { Button, Card, CardContent } from "@eidetic/ui";
import { createCumulusId, signIn, signOut, type CidProfile } from "./cid";

/** The desk's only sign-in: Cumulus ID, with "Create a Cumulus ID" in the same flow. */
export function CidSignIn({ desk, error, signedIn }: { desk: string; error?: string | null; signedIn?: boolean }) {
  return (
    <Card className="max-w-xl">
      <CardContent className="grid gap-4 pt-5">
        <div>
          <h2 className="text-lg font-semibold">Sign in to the {desk}</h2>
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

/** Who is signed in, for the app bar. */
export function CidAccount({ profile }: { profile: CidProfile | null }) {
  if (!profile) return null;
  const who = profile.email || profile.username || profile.cid;
  return (
    <span className="cid-account flex items-center gap-2 text-sm">
      <span title={`Signed in with Cumulus ID as ${who}`}>{who}</span>
      <Button type="button" variant="ghost" size="sm" onClick={signOut}>
        Sign out
      </Button>
    </span>
  );
}
