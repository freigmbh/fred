import * as React from "react"
import { cn } from "cn"
import { ChevronDownIcon } from "lucide-react"

// The stock control look, shared by the select and by a `face` drawn in its place.
const controlClassName =
  "h-7 w-full min-w-0 appearance-none rounded-md border border-input bg-input/20 py-0.5 pr-6 pl-2 text-xs/relaxed transition-colors outline-none select-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 data-[size=sm]:h-6 data-[size=sm]:text-[0.625rem] dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"

type NativeSelectProps = Omit<React.ComponentProps<"select">, "size"> & {
  size?: "sm" | "default"
  face?: React.ReactNode
}

// Project addition to the stock component: `face` is what the closed control shows, for example a SelectPrefix with the
// value or a lab icon with a short model name. The face takes the stock control look and the select lies invisible over
// it, so the control is as wide as its face while the open list and the keyboard stay native. Without `face` the select
// shows its own text.
function NativeSelect({
  className,
  size = "default",
  face,
  ...props
}: NativeSelectProps) {
  return (
    <div
      className={cn(
        "group/native-select relative w-fit has-[select:disabled]:opacity-50",
        className
      )}
      data-slot="native-select-wrapper"
      data-size={size}
    >
      {face ? (
        <span
          aria-hidden="true"
          data-slot="native-select-face"
          data-size={size}
          className={cn(
            controlClassName,
            "flex items-center gap-1.5 whitespace-nowrap group-has-[select:focus-visible]/native-select:border-ring group-has-[select:focus-visible]/native-select:ring-2 group-has-[select:focus-visible]/native-select:ring-ring/30"
          )}
        >
          {face}
        </span>
      ) : null}
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          controlClassName,
          face && "absolute inset-0 h-full cursor-pointer opacity-0"
        )}
        {...props}
      />
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-1.5 size-3.5 -translate-y-1/2 text-muted-foreground select-none group-data-[size=sm]/native-select:size-3 group-data-[size=sm]/native-select:-translate-y-[calc(--spacing(1.25))]" aria-hidden="true" data-slot="native-select-icon" />
    </div>
  )
}

function NativeSelectOption({
  className,
  ...props
}: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  )
}

function NativeSelectOptGroup({
  className,
  ...props
}: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  )
}

// Project addition: the faint prefix of a face, "Status" before "All".
function SelectPrefix({ children }: { children: React.ReactNode }) {
  return <span className="text-faint">{children}</span>
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption, SelectPrefix }
