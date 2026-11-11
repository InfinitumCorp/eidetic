// © Infinitum Corporation®. All rights reserved.
//
// People sign in to this desk with Cumulus ID. /cumulus-id.js (loaded in index.html) runs the
// OAuth code + PKCE flow against the issuer and keeps the token in this tab. The API checks the
// token at the issuer and maps the Cumulus ID to a role.
//
// Local development only: VITE_EIDETIC_DEV_BEARER=dev-admin (with EIDETIC_DEV_BEARER=true on the
// API) skips Cumulus ID. It is ignored in production builds.

import { useEffect, useState } from "react";

export interface CidProfile {
  cid: string;
  username?: string;
  email?: string;
  name?: string;
}

interface CumulusIdApi {
  profile(): CidProfile | null;
  token(): string | null;
  signIn(): void;
  create(): void;
  signOut(): void;
}

declare global {
  interface Window {
    CumulusID?: CumulusIdApi;
  }
}

const devBearer: string | null =
  import.meta.env.DEV && import.meta.env.VITE_EIDETIC_DEV_BEARER ? String(import.meta.env.VITE_EIDETIC_DEV_BEARER) : null;

export const cidToken = (): string | null => devBearer ?? window.CumulusID?.token() ?? null;

export const signIn = () => window.CumulusID?.signIn();
export const createCumulusId = () => window.CumulusID?.create();
export const signOut = () => window.CumulusID?.signOut();

/** The signed-in Cumulus ID profile, kept current with the "cumulus-id" window event. */
export function useCumulusId(): { profile: CidProfile | null; token: string | null } {
  const read = () => ({
    profile: devBearer ? { cid: devBearer, username: `${devBearer} (local dev)` } : (window.CumulusID?.profile() ?? null),
    token: cidToken(),
  });
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => setState(read());
    window.addEventListener("cumulus-id", update);
    update();
    return () => window.removeEventListener("cumulus-id", update);
  }, []);
  return state;
}
