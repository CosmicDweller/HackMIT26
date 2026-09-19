export type Speaker = "doctor" | "patient";

export interface TranscriptChunk {
  id: string;
  speaker: Speaker;
  startMs: number;
  endMs: number;
  text: string;
}

export interface SoapClaim {
  id: string;
  text: string;
  transcriptChunkIds: string[];
}

export interface SoapSection {
  id: "subjective" | "objective" | "assessment" | "plan";
  title: string;
  claims: SoapClaim[];
}

export interface SoapNote {
  id: string;
  sessionId: string;
  generatedAt: string;
  sections: SoapSection[];
}

export interface VoiceProfile {
  id: string;
  label: string;
  createdAt: string;
}

export interface VisitSession {
  id: string;
  patientVoiceProfileId: string;
  doctorVoiceProfileId: string;
  status: "recording" | "processing" | "ready";
  createdAt: string;
}
