import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ErrorCode } from "@/types";

const CATEGORY_LABEL: Record<ErrorCode, string> = {
  INVALID_AUDIO: "Invalid audio",
  FILE_TOO_LARGE: "File too large",
  TRANSCRIPTION_FAILED: "Transcription failed",
  SERVICE_UNAVAILABLE: "Service unavailable",
  UNAUTHENTICATED: "Not signed in",
  NOT_FOUND: "Not found",
  INVALID_REQUEST: "Invalid request",
  SERVER_ERROR: "Server error",
  NETWORK_ERROR: "Connection problem",
  UNSUPPORTED_FILE: "Unsupported file",
};

interface ErrorBannerProps {
  code: ErrorCode;
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
