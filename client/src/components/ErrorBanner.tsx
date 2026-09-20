import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

// Covers both REST error codes ({error,code}) and job error codes (docs/API_CONTRACT.md
// "Job error codes") — kept as a permissive Record<string,...> since the backend may add
// codes over time; unrecognized ones still display gracefully via the "Error" fallback.
const CATEGORY_LABEL: Record<string, string> = {
  INVALID_AUDIO: "Invalid audio",
  FILE_TOO_LARGE: "File too large",
  TRANSCRIPTION_FAILED: "Transcription failed",
  SERVICE_UNAVAILABLE: "Service unavailable",
  UNAUTHENTICATED: "Not signed in",
  NOT_FOUND: "Not found",
  INVALID_REQUEST: "Invalid request",
  SERVER_ERROR: "Server error",
  CONFLICT: "Changed elsewhere",
  NETWORK_ERROR: "Connection problem",
  UNSUPPORTED_FILE: "Unsupported file",
  // Job error codes (Contract v3)
  RECORDING_TOO_LONG: "Recording too long",
  NO_SPEECH: "No speech detected",
  PROVIDER_BAD_AUDIO: "Audio couldn't be processed",
  PROVIDER_NOT_CONFIGURED: "Transcription not configured",
  PROVIDER_AUTH_FAILED: "Transcription service authentication failed",
  PROVIDER_ACCOUNT_LIMIT: "Account limit reached",
  PROVIDER_MODEL_UNAVAILABLE: "Model unavailable",
  PROVIDER_RATE_LIMITED: "Transcription service is busy",
  PROVIDER_TIMEOUT: "Transcription timed out",
  PROVIDER_UNAVAILABLE: "Transcription service unavailable",
  PROVIDER_MALFORMED_RESPONSE: "Unexpected response from transcription service",
  LONG_RECORDING_NEEDS_CALLBACK: "Recording too long for this setup",
  INTERRUPTED: "Interrupted",
  CALLBACK_TIMEOUT: "Timed out waiting for results",
  INTERNAL: "Internal error",
};

interface ErrorBannerProps {
  code: string;
  message: string;
  onRetry: () => void;
  onStartOver: () => void;
}

export function ErrorBanner({ code, message, onRetry, onStartOver }: ErrorBannerProps) {
  return (
    <div className="flex flex-col items-center gap-4 py-10 text-center">
      <AlertCircle className="size-8 text-destructive" />
      <div>
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {CATEGORY_LABEL[code] ?? "Error"}
        </p>
        <p className="mt-1 text-sm font-medium text-foreground">{message}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onStartOver}>
          Start Over
        </Button>
        <Button onClick={onRetry}>Retry</Button>
      </div>
    </div>
  );
}
