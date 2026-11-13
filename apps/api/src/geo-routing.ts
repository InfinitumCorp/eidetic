// © Infinitum Corporation®. All rights reserved.

import { EideticError } from "@eidetic/contracts";
import {
  annotateRouting,
  geoRoutingActive,
  loadV2RayDataset,
  readGeoRoutingSettings,
  writeGeoRoutingSettings,
  type GeoRoutingAnnotation,
  type RoutingHint,
  type V2RayGeoDataset,
} from "@eidetic/geo";
import { attachGeoRoutingAnnotation, type PolicyDecision } from "@eidetic/policy";

export interface GeoRoutingView {
  geoRouting: boolean;
  processOptIn: boolean;
  active: boolean;
  identityMatch: false;
}

export interface GeoRoutingService {
  processOptIn: boolean;
  read(): GeoRoutingView;
  write(geoRouting: boolean): GeoRoutingView;
  active(): boolean;
  lookup(hint: RoutingHint): GeoRoutingAnnotation | null;
  annotatePolicy<T extends PolicyDecision>(
    decision: T,
    routing: RoutingHint | undefined,
  ): T & { geoRouting?: GeoRoutingAnnotation };
}

export function createGeoRouting(options: {
  processOptIn: boolean;
  dataDir: string;
  settingsPath: string;
  log?: (line: Record<string, unknown>) => void;
  loadDataset?: () => V2RayGeoDataset;
}): GeoRoutingService {
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));
  let loaded: V2RayGeoDataset | null | undefined;
  let warned = false;

  function dataset(): V2RayGeoDataset | null {
    if (loaded !== undefined) return loaded;
    try {
      loaded = options.loadDataset ? options.loadDataset() : loadV2RayDataset(options.dataDir);
    } catch {
      loaded = null;
      if (!warned) {
        warned = true;
        log({
          level: "warn",
          msg: "Geo routing datasets are not loaded. Annotations stay empty until the v2fly files are fetched. Identity matching is unchanged.",
          identityMatch: false,
        });
      }
    }
    return loaded;
  }

  function view(): GeoRoutingView {
    const settings = readGeoRoutingSettings(options.settingsPath);
    return {
      geoRouting: settings.geoRouting,
      processOptIn: options.processOptIn,
      active: geoRoutingActive(options.processOptIn, settings),
      identityMatch: false,
    };
  }

  return {
    processOptIn: options.processOptIn,
    read: view,
    write(geoRouting) {
      writeGeoRoutingSettings(options.settingsPath, geoRouting);
      return view();
    },
    active() {
      return view().active;
    },
    lookup(hint) {
      if (!view().active) return null;
      const data = dataset();
      if (!data) return null;
      return annotateRouting(data, hint);
    },
    annotatePolicy(decision, routing) {
      if (!view().active || (!routing?.ip && !routing?.domain)) return decision;
      let note: GeoRoutingAnnotation | null;
      try {
        note = this.lookup(routing);
      } catch (error) {
        if (error instanceof EideticError && error.code === "PERSON_TRACKING_REFUSED") {
          log({ level: "warn", msg: "Geo routing skipped. Identity matching is refused.", identityMatch: false });
          return decision;
        }
        return decision;
      }
      if (!note) return decision;
      log({
        level: "info",
        msg: "geo routing annotation",
        countryCode: note.countryCode,
        categories: note.categories,
        identityMatch: false,
      });
      return attachGeoRoutingAnnotation(decision, note);
    },
  };
}
