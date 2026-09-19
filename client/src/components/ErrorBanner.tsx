import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ErrorCode } from "@/types";

const FRIENDLY_MESSAGE: Record<ErrorCode, string> = {
  INVALID_AUDIO: "That audio couldn't be processed. Try a different recording or file.",
  FILE_TOO_LARGE: "That file is too large for the transcription service.",
  TRANSCRIPTION_FAILED: "Transcription failed. You can try again.",
  SERVICE_UNAVAILABLE: "The transcription service is temporarily unavailable.",
  NETWORK_ERROR: "Couldn't reach the server. Check your connection and try again.",
  UNSUPPORTED_FILE: "That file type isn't supported.",
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
        <p className="text-sm font-medium text-foreground">
          {FRIENDLY_MESSAGE[code] ?? message}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{message}</p>
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
