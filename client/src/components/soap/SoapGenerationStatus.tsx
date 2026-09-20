import { AlertTriangle, Loader2 } from "lucide-react";
import type { SoapGenerationStage } from "@/types";

const STAGE_LABEL: Record<NonNullable<SoapGenerationStage>, string> = {
  queued: "Queued…",
  extracting: "Extracting clinical statements…",
  drafting: "Drafting the note…",
  validating: "Validating citations…",
};

/** Friendly wording for the backend's failure codes. Unknown codes fall back to the raw
 * code rather than a vague "something went wrong". */
const ERROR_LABEL: Record<string, string> = {
  PROVIDER_NOT_CONFIGURED: "The note-generation service isn't configured on the server.",
  PROVIDER_AUTH_FAILED: "The note-generation service rejected the server's credentials.",
  PROVIDER_RATE_LIMITED: "The note-generation service is rate limited. Try again shortly.",
  PROVIDER_QUOTA_EXCEEDED: "The note-generation service's quota is used up for now. Try again later.",
  PROVIDER_TIMEOUT: "The note-generation service took too long to respond.",
  PROVIDER_UNAVAILABLE: "The note-generation service is unavailable.",
  PROVIDER_MODEL_UNAVAILABLE: "The configured model isn't available.",
  PROVIDER_BAD_OUTPUT: "The note-generation service returned something unusable.",
  GENERATION_FAILED: "Generating this note failed.",
  INTERRUPTED: "Generation was interrupted before it finished.",
  EMPTY_TRANSCRIPT: "There's no transcript text to write a note from.",
};

export function SoapGenerationStatus({
  stage,
  errorCode,
}: {
  stage: SoapGenerationStage;
  errorCode?: string | null;
}) {
  if (errorCode) {
    return (
      <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>
          SOAP note generation failed. {ERROR_LABEL[errorCode] ?? errorCode}
          <span className="mt-0.5 block text-xs opacity-80">
            The transcript itself is unaffected.
          </span>
        </span>
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
