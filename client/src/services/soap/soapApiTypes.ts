import type { SoapNote, SoapPreference, SoapSectionKey, SoapTemplate, SoapTemplateId } from "@/types";

export interface SoapApi {
  listTemplates(): Promise<SoapTemplate[]>;
  getPreference(): Promise<SoapPreference>;
  setPreference(templateId: SoapTemplateId): Promise<SoapPreference>;
  /** null when no SOAP note has been created for this transcription yet (404). */
  get(transcriptionId: string): Promise<SoapNote | null>;
  /** Idempotent recovery/creation — only call when get() returned null. */
  create(transcriptionId: string): Promise<SoapNote>;
  update(
    transcriptionId: string,
    patch: { sections: Record<SoapSectionKey, string>; revision: number },
  ): Promise<SoapNote>;
  approve(transcriptionId: string, revision: number): Promise<SoapNote>;
  export(transcriptionId: string, format: "pdf" | "txt"): Promise<Blob>;
}
