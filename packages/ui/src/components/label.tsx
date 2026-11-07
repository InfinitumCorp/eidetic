// © Infinitum Corporation®. All rights reserved.

import type * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "../lib/utils";

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn("text-sm font-medium text-foreground", className)} {...props} />;
}
