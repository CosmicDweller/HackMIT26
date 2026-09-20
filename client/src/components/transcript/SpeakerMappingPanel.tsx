import { AlertTriangle, Check, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { speakerColor } from "@/lib/speakerColors";
import { cn } from "@/lib/utils";
import type { Speaker, SpeakerRole } from "@/types";

const ROLE_OPTIONS: { value: SpeakerRole; label: string }[] = [
  { value: "doctor", label: "Doctor" },
  { value: "patient", label: "Patient" },
  { value: "other", label: "Other" },
  { value: "unassigned", label: "Unassigned" },
];

interface SpeakerMappingPanelProps {
  speakers: Speaker[];
  isSaving: (key: string) => boolean;
  onChangeRole: (speakerId: string, role: SpeakerRole) => void;
}

export function SpeakerMappingPanel({ speakers, isSaving, onChangeRole }: SpeakerMappingPanelProps) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <p className="text-sm font-medium">Who's who?</p>
      <p className="text-xs text-muted-foreground">
        Confirm which detected speaker is the doctor and which is the patient. This updates
        every segment for that speaker.
      </p>
      <div className="space-y-3">
        {speakers.map((speaker, i) => {
          const color = speakerColor(i);
          const saving = isSaving(`speaker:${speaker.id}`);
          return (
            <div key={speaker.id} className="flex flex-wrap items-center gap-3">
              <span
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                  color.bg,
                  color.text,
                )}
              >
                <span className={cn("size-1.5 rounded-full", color.dot)} />
                {speaker.label}
              </span>
              {speaker.role === "unassigned" && speaker.suggestedRole === "doctor" && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-500" />
                  This looks like you
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={saving}
                    onClick={() => onChangeRole(speaker.id, "doctor")}
                  >
                    <Check className="size-3" />
                    Confirm
                  </Button>
                </span>
              )}
              {/* "unknown" needs no special message — it's a fairly confident non-match, not
                  ambiguous. Only "uncertain" (not enough evidence either way) gets a warning. */}
              {speaker.role === "unassigned" && speaker.identificationStatus === "uncertain" && (
                <span className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="size-3.5" />
                  Voice match uncertain — please check
                </span>
              )}
              <div className="inline-flex rounded-lg border border-border bg-muted p-1">
                {ROLE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={saving}
                    onClick={() => onChangeRole(speaker.id, option.value)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                      speaker.role === option.value
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {saving && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
