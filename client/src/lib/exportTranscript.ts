import { formatSeconds } from "@/lib/format";
import type { Speaker, TranscriptSegment } from "@/types";

const ROLE_LABEL: Record<Speaker["role"], string> = {
  doctor: "Doctor",
  patient: "Patient",
  other: "Other",
  unassigned: "Unassigned speaker",
};

export function speakerDisplayLabel(speaker: Speaker | undefined): string {
  if (!speaker) return "Unknown speaker";
  if (speaker.role !== "unassigned") return ROLE_LABEL[speaker.role];
  // A "matched" voice suggestion is never surfaced as an identity here — it's a
  // suggestion the doctor must confirm via role (see SpeakerMappingPanel), not a label.
  return speaker.identificationStatus === "unknown" ? `Unknown ${speaker.label}` : speaker.label;
}

export function formatTranscriptForExport(
  segments: TranscriptSegment[],
  speakers: Speaker[],
): string {
  const byId = new Map(speakers.map((s) => [s.id, s]));
  return segments
    .map((segment) => {
      const label = segment.speakerId
        ? speakerDisplayLabel(byId.get(segment.speakerId))
        : "Unknown speaker";
      const timestamp = formatSeconds(segment.startMs / 1000);
      return `${label} [${timestamp}]\n${segment.text}`;
    })
    .join("\n\n");
}

export function downloadTextFile(fileName: string, contents: string) {
  const blob = new Blob([contents], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
