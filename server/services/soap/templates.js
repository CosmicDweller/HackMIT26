// The SOAP templates a doctor can choose from. All three produce the SAME four sections from the SAME evidence: they change only
// how much detail is written, never what may be written. A template can never permit a fact that is not in the transcript.

export const SECTIONS = ["subjective", "objective", "assessment", "plan"];

export const SECTION_TITLES = {
  subjective: "S — Subjective",
  objective: "O — Objective",
  assessment: "A — Assessment",
  plan: "P — Plan",
};

export const TEMPLATES = [
  {
    id: "primary-care-standard",
    name: "Primary care (standard)",
    description: "A balanced outpatient note: complete but concise sentences, the usual level of detail for a routine visit.",
    style:
      "Write each section as short, complete clinical sentences or brief bullet-style lines. Include every documented finding once, "
      + "without repeating the same fact in several sections.",
  },
  {
    id: "primary-care-concise",
    name: "Primary care (concise)",
    description: "The shortest defensible note: clipped clinical phrases, one line per documented finding.",
    style:
      "Write in clipped clinical shorthand (sentence fragments are fine, e.g. 'Right temporal headache x3 days, 7-8/10'). One short line "
      + "per documented finding. Omit narrative connective text. Never omit a documented clinical fact to save space.",
  },
  {
    id: "primary-care-detailed",
    name: "Primary care (detailed)",
    description: "A fuller narrative: the patient's own descriptions and the clinician's reasoning, as documented.",
    style:
      "Write fuller narrative prose, preserving the patient's own descriptive wording (for example how they described the pain) and the "
      + "clinician's stated reasoning. Detail means saying more about what WAS documented, never adding findings that were not.",
  },
];

export const DEFAULT_TEMPLATE_ID = "primary-care-standard";
export const templateById = (id) => TEMPLATES.find((template) => template.id === id) ?? null;
export const isTemplateId = (id) => TEMPLATES.some((template) => template.id === id);

/** The public listing (id, name, description only: the prompt text is internal). */
export const publicTemplates = () => TEMPLATES.map(({ id, name, description }) => ({ id, name, description }));
