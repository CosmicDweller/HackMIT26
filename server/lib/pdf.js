// A small PDF writer for text documents: headings, paragraphs and page breaks, with the standard Helvetica fonts. Enough for a SOAP
// note and nothing more, so the project gains no dependency for one export format. Output is a real PDF 1.4 file (valid xref table,
// WinAnsi text encoding) that opens in Preview, Acrobat and browsers.

// Helvetica character widths (1/1000 em) for the printable ASCII range, from the standard AFM metrics: used for line wrapping.
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722,
  667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

const BOLD_FACTOR = 1.08; // Helvetica-Bold is slightly wider; headings are short, so this approximation is plenty for wrapping.

/** Characters outside ASCII that a clinical note actually uses, mapped to their WinAnsiEncoding byte. */
const WINANSI = { "—": 151, "–": 150, "‘": 145, "’": 146, "“": 147, "”": 148, "…": 133, "°": 176, "µ": 181, "é": 233, "½": 189 };

function widthOf(text, size, bold) {
  let units = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    units += code >= 32 && code <= 126 ? HELVETICA[code - 32] : 556; // anything mapped is about average width
  }
  return (units / 1000) * size * (bold ? BOLD_FACTOR : 1);
}

/** PDF string literal: WinAnsi bytes with (, ) and \ escaped. Unmapped characters become "?" rather than corrupting the file. */
function escape(text) {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0);
    let byte;
    if (code >= 32 && code <= 126) byte = code;
    else if (WINANSI[character]) byte = WINANSI[character];
    else if (code === 9) byte = 32;
    else byte = 63;
    if (byte === 40 || byte === 41 || byte === 92) out += `\\${String.fromCharCode(byte)}`;
    else if (byte > 126) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return out;
}

/** Break `text` into lines that fit `maxWidth`. Words longer than a line are split rather than overflowing. */
function wrap(text, size, bold, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    if (!paragraph.trim()) { lines.push(""); continue; }
    let current = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (widthOf(candidate, size, bold) <= maxWidth) { current = candidate; continue; }
      if (current) lines.push(current);
      if (widthOf(word, size, bold) <= maxWidth) { current = word; continue; }
      let piece = "";
      for (const character of word) {
        if (widthOf(piece + character, size, bold) > maxWidth) { lines.push(piece); piece = character; }
        else piece += character;
      }
      current = piece;
    }
    if (current) lines.push(current);
  }
  return lines;
}

/**
 * Build a PDF from a block list. Each block is one of:
 *   { type: "heading", text }        a bold section heading
 *   { type: "title", text }          the document title
 *   { type: "paragraph", text }      body text (blank lines separate paragraphs)
 *   { type: "meta", text }           small grey-ish footnote text
 *   { type: "space", height }        vertical space
 *   { type: "rule" }                 a horizontal line
 * Returns a Buffer. Pages are A4 with a 56 pt margin and a "Page n of m" footer.
 */
export function buildPdf(blocks, { title = "Document", pageWidth = 595.28, pageHeight = 841.89, margin = 56 } = {}) {
  const contentWidth = pageWidth - margin * 2;
  const pages = [];
  let current = [];
  let y = pageHeight - margin;
  const bottom = margin + 24; // leave room for the footer

  const newPage = () => { pages.push(current); current = []; y = pageHeight - margin; };
  const need = (height) => { if (y - height < bottom) newPage(); };

  const SIZES = { title: 17, heading: 12, paragraph: 10.5, meta: 8.5 };
  const LEADING = { title: 22, heading: 16, paragraph: 14.5, meta: 11.5 };

  for (const block of blocks) {
    if (block.type === "space") { y -= block.height ?? 10; continue; }
    if (block.type === "rule") {
      need(12);
      current.push({ kind: "rule", y: y - 4, from: margin, to: pageWidth - margin });
      y -= 12;
      continue;
    }
    const bold = block.type === "heading" || block.type === "title";
    const size = SIZES[block.type] ?? SIZES.paragraph;
    const leading = LEADING[block.type] ?? LEADING.paragraph;
    if (block.type === "heading") y -= 6; // a little air above a heading
    for (const line of wrap(block.text ?? "", size, bold, contentWidth)) {
      need(leading);
      if (line) current.push({ kind: "text", text: line, x: margin, y: y - size, size, bold, grey: block.type === "meta" });
      y -= leading;
    }
    if (block.type === "heading") y -= 2;
  }
  pages.push(current);

  // ---- assemble the file ----
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; }; // 1-based object numbers

  // The catalog and the page tree must exist before the pages that reference them, but their contents are only known at the end.
  // Reserve their slots first so no later object can be given the same number.
  const catalogNumber = add(null);
  const pagesNumber = add(null);
  const fontRegular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const fontBold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  const pageNumbers = [];
  pages.forEach((items, index) => {
    const parts = [];
    for (const item of items) {
      if (item.kind === "rule") {
        parts.push(`0.75 w 0.6 0.6 0.6 RG ${item.from.toFixed(2)} ${item.y.toFixed(2)} m ${item.to.toFixed(2)} ${item.y.toFixed(2)} l S`);
        continue;
      }
      const grey = item.grey ? "0.35 0.35 0.35 rg" : "0 0 0 rg";
      parts.push(`BT ${grey} /${item.bold ? "FB" : "FR"} ${item.size} Tf 1 0 0 1 ${item.x.toFixed(2)} ${item.y.toFixed(2)} Tm (${escape(item.text)}) Tj ET`);
    }
    const footer = `Page ${index + 1} of ${pages.length}`;
    const footerX = pageWidth - margin - widthOf(footer, 8.5, false);
    parts.push(`BT 0.45 0.45 0.45 rg /FR 8.5 Tf 1 0 0 1 ${footerX.toFixed(2)} ${(margin - 8).toFixed(2)} Tm (${escape(footer)}) Tj ET`);
    const stream = parts.join("\n");
    const contentNumber = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    pageNumbers.push(add(
      `<< /Type /Page /Parent ${pagesNumber} 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] `
      + `/Resources << /Font << /FR ${fontRegular} 0 R /FB ${fontBold} 0 R >> >> /Contents ${contentNumber} 0 R >>`,
    ));
  });

  objects[catalogNumber - 1] = `<< /Type /Catalog /Pages ${pagesNumber} 0 R >>`;
  objects[pagesNumber - 1] = `<< /Type /Pages /Kids [${pageNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pageNumbers.length} >>`;
  const info = add(`<< /Title (${escape(title)}) /Producer (Scribe) /CreationDate (D:${stamp()}) >>`);

  const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, index) => {
    const buffer = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    offsets.push(offset);
    offset += buffer.length;
    chunks.push(buffer);
  });
  const xrefAt = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const value of offsets) xref += `${String(value).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNumber} 0 R /Info ${info} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}
