import { AlertTriangle, ClipboardList, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SoapClaim, SoapSectionKey } from "@/types";

interface SoapSectionEditorProps {
  sectionKey: SoapSectionKey;
  heading: string;
  text: string;
  claims: SoapClaim[];
  editing: boolean;
  readOnly: boolean;
  onToggleEdit: () => void;
  onChange: (text: string) => void;
  onClaimClick: (claim: SoapClaim) => void;
}

export function SoapSectionEditor({
  heading,
  text,
  claims,
  editing,
  readOnly,
  onToggleEdit,
  onChange,
  onClaimClick,
}: SoapSectionEditorProps) {
  const isEmpty = text.trim().length === 0;

  return (
    <div className="space-y-2 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{heading}</h3>
        {!readOnly && (
          <Button variant="ghost" size="xs" onClick={onToggleEdit}>
            <Pencil className="size-3.5" />
            {editing ? "Done" : "Edit"}
          </Button>
        )}
      </div>

      {isEmpty && !editing && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground italic">
          <AlertTriangle className="size-3.5 shrink-0" />
          No documented information for this section.
        </p>
      )}

      {editing ? (
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          placeholder="Leave blank if nothing was documented — never guess."
          className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-sm leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      ) : claims.length > 0 ? (
        <ul className="space-y-1.5">
          {claims.map((claim) => (
            <li key={claim.id}>
              <button
                type="button"
                onClick={() => onClaimClick(claim)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm leading-relaxed transition-colors hover:bg-muted",
                  claim.needsReview && "bg-amber-50 dark:bg-amber-950/40",
                )}
              >
                <ClipboardList className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1">{claim.text}</span>
                {claim.needsReview && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                    <AlertTriangle className="size-3" />
                    Review
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        !isEmpty && <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
      )}
    </div>
  );
}
