import { Loader2 } from "lucide-react";
import { useSoapPreference } from "@/hooks/useSoapPreference";
import { cn } from "@/lib/utils";

/** Lets the doctor choose (and persist) their default SOAP template before recording.
 * Once a consultation's SOAP note has been generated, its templateId is fixed —
 * changing this preference afterward never affects an existing note. */
export function SoapTemplatePicker() {
  const { templates, templateId, loading, saving, error, choose } = useSoapPreference();

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Loading SOAP templates…
      </p>
    );
  }
  if (error || !templates || !templateId) {
    return <p className="text-xs text-destructive">{error ?? "Couldn't load SOAP templates."}</p>;
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        SOAP note template {saving && <span className="text-muted-foreground/70">(saving…)</span>}
      </p>
      <div className="inline-flex flex-wrap rounded-lg border border-border bg-muted p-1">
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            title={template.description}
            disabled={saving}
            onClick={() => choose(template.id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
              templateId === template.id
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {template.name}
          </button>
        ))}
      </div>
    </div>
  );
}
