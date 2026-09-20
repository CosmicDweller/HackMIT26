import { buildPdf } from "../../lib/pdf.js";
import { SECTION_TITLES, SECTIONS, templateById } from "./templates.js";

// Exporting an APPROVED note as PDF or plain text. Export is a rendering step and nothing else: it copies the approved text exactly,
// adds no clinical content, invents no codes, and carries no patient identifiers (the MVP stores none).

const stamp = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
};

/** A filename that is safe on every platform and reveals nothing clinical. */
export function exportFilename(note, format) {
  const day = (note.approvedAt ?? note.updatedAt ?? new Date().toISOString()).slice(0, 10);
  const shortId = String(note.transcriptionId).replace(/[^a-zA-Z0-9]/g, "").slice(-8);
  return `soap-note-${day}-${shortId}.${format}`;
}

const header = (note, transcription) => {
  const template = templateById(note.templateId);
  return [
    `Consultation: ${transcription.createdAt ? stamp(transcription.createdAt) : "date not recorded"}`,
    transcription.durationSeconds ? `Duration: ${Math.round(transcription.durationSeconds / 60)} min` : null,
    `Template: ${template?.name ?? note.templateId}`,
    note.approvedAt ? `Reviewed and approved: ${stamp(note.approvedAt)}` : null,
  ].filter(Boolean);
};

const FOOTNOTE = "Drafted from a recorded consultation by an AI documentation assistant and reviewed by the clinician named above. "
  + "Approval records clinician review; it is not an electronic signature.";

export function toText(note, transcription) {
  const parts = ["SOAP NOTE", "=========", "", ...header(note, transcription), ""];
  for (const section of SECTIONS) {
    parts.push(SECTION_TITLES[section], "-".repeat(SECTION_TITLES[section].length));
    const body = note.sections[section]?.trim();
    parts.push(body || "(nothing documented)", "");
  }
  parts.push("", FOOTNOTE);
  return `${parts.join("\n")}\n`;
}

export function toPdf(note, transcription) {
  const blocks = [
    { type: "title", text: "SOAP Note" },
    { type: "space", height: 2 },
    ...header(note, transcription).map((text) => ({ type: "meta", text })),
    { type: "rule" },
  ];
  for (const section of SECTIONS) {
    blocks.push({ type: "heading", text: SECTION_TITLES[section] });
    const body = note.sections[section]?.trim();
    blocks.push({ type: "paragraph", text: body || "(nothing documented)" });
    blocks.push({ type: "space", height: 6 });
  }
  blocks.push({ type: "rule" }, { type: "meta", text: FOOTNOTE });
  return buildPdf(blocks, { title: "SOAP Note" });
}

export const MIME = { pdf: "application/pdf", txt: "text/plain; charset=utf-8" };
