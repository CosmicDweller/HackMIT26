import { USE_MOCK_VOICE_PROFILE } from "@/services/voiceProfile/config";
import { mockVoiceProfileApi } from "@/services/voiceProfile/mockVoiceProfileApi";
import { voiceProfileApi } from "@/services/voiceProfile/voiceProfileApi";
import type { VoiceProfileApi } from "@/services/voiceProfile/voiceProfileApiTypes";

export const voiceProfile: VoiceProfileApi = USE_MOCK_VOICE_PROFILE
  ? mockVoiceProfileApi
  : voiceProfileApi;
