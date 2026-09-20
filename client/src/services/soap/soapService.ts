import { USE_MOCK_SOAP } from "@/services/soap/config";
import { mockSoapApi } from "@/services/soap/mockSoapApi";
import { soapApi } from "@/services/soap/soapApi";
import type { SoapApi } from "@/services/soap/soapApiTypes";

export const soap: SoapApi = USE_MOCK_SOAP ? mockSoapApi : soapApi;

export { USE_MOCK_SOAP } from "@/services/soap/config";
