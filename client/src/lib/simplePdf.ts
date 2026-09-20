/**
 * Minimal, dependency-free single/multi-page PDF writer for plain text — used only by
 * the mock SOAP export (the real backend generates the PDF; this exists purely so the
 * export flow can be built and demoed before that endpoint exists). Base-14 Helvetica,
 * no font embedding. Non-Latin-1 characters are not supported (a known limitation of
 * this placeholder, not of the real export).
 */

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const words = line.split(" ");
  const wrapped: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      wrapped.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) wrapped.push(current);
  return wrapped;
}

export interface SimplePdfSection {
  heading: string;
  /** Raw section text, "\n" separated. Left as-is (including empty) — never filled in. */
  body: string;
}

export function buildSimplePdf(title: string, sections: SimplePdfSection[]): Blob {
  const MAX_CHARS = 92;
  const LINES_PER_PAGE = 46;

  const lines: string[] = [title, ""];
  for (const { heading, body } of sections) {
    lines.push(heading.toUpperCase());
    if (body.trim().length > 0) {
      for (const raw of body.split("\n")) {
        if (raw.trim() === "") {
          lines.push("");
        } else {
          lines.push(...wrapLine(raw, MAX_CHARS));
        }
      }
    }
    lines.push("");
  }

  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE));
  }
  if (pages.length === 0) pages.push([""]);

  let nextObjNum = 3;
  const pageObjNums: number[] = [];
  const contentObjNums: number[] = [];
  for (let p = 0; p < pages.length; p++) {
    pageObjNums.push(nextObjNum++);
    contentObjNums.push(nextObjNum++);
  }
  const fontObjNum = nextObjNum++;

  const objects: string[] = [];
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj\n`,
  );

  for (let p = 0; p < pages.length; p++) {
    const pageNum = pageObjNums[p];
    const contentNum = contentObjNums[p];
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    let stream = "BT /F1 11 Tf 72 740 Td 14 TL\n";
    for (const line of pages[p]) {
      stream += `(${escapePdfText(line)}) Tj T*\n`;
    }
    stream += "ET";
    objects.push(`${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  }
  objects.push(`${fontObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefStart = pdf.length;
  const totalObjs = objects.length + 1;
  pdf += `xref\n0 ${totalObjs}\n0000000000 65535 f \n`;
  for (let i = 1; i < totalObjs; i++) {
    pdf += `${offsets[i].toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  // Build as raw Latin-1 bytes (not the default UTF-8 Blob encoding) so the
  // computed /Length values above stay byte-exact.
  const bytes = Uint8Array.from(pdf, (c) => c.charCodeAt(0) & 0xff);
  return new Blob([bytes], { type: "application/pdf" });
}
