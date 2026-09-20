import { AlertTriangle, Loader2 } from "lucide-react";
import type { SoapGenerationError, SoapGenerationStage } from "@/types";

const STAGE_LABEL: Record<NonNullable<SoapGenerationStage>, string> = {
  queued: "Queued…",
  extracting: "Extracting clinical statements…",
  drafting: "Drafting the note…",
  validating: "Validating citations…",
};

export function SoapGenerationStatus({
  stage,
  error,
}: {
  stage: SoapGenerationStage;
  error?: SoapGenerationError | null;
}) {
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <AlertTriangle className="size-4 shrink-0" />
        <span>SOAP note generation failed: {error.message}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 shrink-0 animate-spin" />
      <span>{stage ? STAGE_LABEL[stage] : "Generating SOAP note…"}</span>
    </div>
  );
}
