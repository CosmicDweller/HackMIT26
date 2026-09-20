import { useCallback, useEffect, useState } from "react";
import { soap } from "@/services/soap/soapService";
import type { SoapTemplate, SoapTemplateId } from "@/types";

/** The doctor's default SOAP template — read before starting a consultation and
 * snapshotted onto the note at generation time (changing it later never affects
 * already-generated notes). */
export function useSoapPreference() {
  const [templates, setTemplates] = useState<SoapTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState<SoapTemplateId | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([soap.listTemplates(), soap.getPreference()])
      .then(([templateList, preference]) => {
        if (cancelled) return;
        setTemplates(templateList);
        setTemplateId(preference.templateId);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load SOAP templates.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = useCallback(async (id: SoapTemplateId) => {
    setSaving(true);
    setError(null);
    try {
      const preference = await soap.setPreference(id);
      setTemplateId(preference.templateId);
    } catch {
      setError("Couldn't save your template preference.");
    } finally {
      setSaving(false);
    }
  }, []);

  return { templates, templateId, loading, saving, error, choose };
}
