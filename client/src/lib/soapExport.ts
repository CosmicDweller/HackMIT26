import type { SoapSectionKey, SoapSections } from "@/types";

export const SOAP_SECTION_ORDER: { key: SoapSectionKey; heading: string }[] = [
  { key: "subjective", heading: "Subjective" },
  { key: "objective", heading: "Objective" },
  { key: "assessment", heading: "Assessment" },
  { key: "plan", heading: "Plan" },
];

/** Plain-text rendering of the four SOAP sections, preserving paragraph breaks. Used
 * for the mock TXT export and for the clipboard copy — approved content only. */
export function formatSoapNoteAsText(sections: SoapSections): string {
  return SOAP_SECTION_ORDER.map(({ key, heading }) => `${heading.toUpperCase()}\n${sections[key].trim()}`.trim())
    .join("\n\n")
    .trim();
}

export function downloadBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
