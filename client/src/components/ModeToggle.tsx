import { Mic, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AudioSource } from "@/types";

interface ModeToggleProps {
  mode: AudioSource;
  onChange: (mode: AudioSource) => void;
  disabled?: boolean;
}

export function ModeToggle({ mode, onChange, disabled }: ModeToggleProps) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-muted p-1">
      {(
        [
          { key: "recording" as const, label: "Record", icon: Mic },
          { key: "upload" as const, label: "Upload", icon: Upload },
        ]
      ).map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          disabled={disabled}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
            mode === key
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          aria-pressed={mode === key}
        >
          <Icon className="size-4" />
          {label}
        </button>
      ))}
    </div>
  );
}
