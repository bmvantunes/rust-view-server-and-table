import { cn } from "#lib/utils";
import { SpinnerIcon } from "@phosphor-icons/react";
import type { ComponentProps } from "react";

function Spinner({ className, ...props }: ComponentProps<typeof SpinnerIcon>) {
  return (
    <SpinnerIcon
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export { Spinner };
