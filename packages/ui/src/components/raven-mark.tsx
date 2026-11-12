// © Infinitum Corporation®. All rights reserved.

import type * as React from "react";

/** The ei·det·ic raven: a perched raven in silhouette, facing the wordmark. Drawn in currentColor. */
export const RAVEN_PATH =
  "M97 31 C90 22 80 19 72 20 C65 13 55 13 49 18 C45 22 44 27 43 31 C37 41 27 51 17 60 L3 79 L8 87 L17 81 C25 77 34 75 43 72 L49 72 L50 86 L43 90 L56 90 L53 86 L53 72 L57 71 L58 86 L53 90 L66 90 L61 86 L61 69 C68 64 72 55 72 47 L70 45.5 L72.5 43.5 L70.5 41.5 L73.5 39 L72 36.5 L77 33 C84 34 91 33 97 31 Z M66.5 24 a2.2 2.2 0 1 0 -4.4 0 a2.2 2.2 0 1 0 4.4 0 Z M57 44 C49 54 38 63 25 72 C39 66 50 58 59 47.5 Z";

export function RavenMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false" {...props}>
      <path fill="currentColor" fillRule="evenodd" d={RAVEN_PATH} />
    </svg>
  );
}
