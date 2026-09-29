import { strToU8, zipSync } from "fflate";
import type { Block, Run } from "../shared/showNotes";
import { fitInside, hasFooter, hasHeader, type CoverPage, type DocBranding, type LogoImage } from "./brandingDoc";

/**
 * Word (.docx / OOXML) writer for the document model in src/shared/showNotes.ts.
 * A .docx is a ZIP of XML parts; this writes the parts Word needs, plus real
 * heading styles and list numbering so the file keeps its structure when
 * it's opened in Word or converted to a Google Doc.
 *
 * Started from Transcriptor 1's minimal writer (paragraphs of runs) and
 * extended with styles, lists, tables, quotes, rules and hyperlinks.
 */

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const HYPERLINK_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture";
/** Namespaces for parts that hold text and pictures. */
const PART_NS = `xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}"`;
const EMU_PER_INCH = 914400;

/** Page width minus margins, in twentieths of a point (8.5" page, 1" margins). */
const TEXT_WIDTH = 9360;

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Remove characters XML 1.0 can't hold (control characters other than tab/newline). */
const xmlSafe = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");

class DocWriter {
  private links: string[] = [];
  /** Ordered lists each get their own numbering instance so they restart at 1. */
  private numbered = 0;

  body(blocks: Block[]): string {
    return blocks.map((b) => this.block(b)).join("");
  }

  relationships(extra: string[] = []): string {
    const rels = [
      `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
      `<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`,
      ...extra,
      ...this.links.map(
        (url, i) => `<Relationship Id="rIdLink${i}" Type="${HYPERLINK_REL}" Target="${escapeXml(url)}" TargetMode="External"/>`,
      ),
    ];
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
  }

  numbering(): string {
    const level = (fmt: "bullet" | "decimal") =>
      `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>` +
      `<w:lvlText w:val="${fmt === "bullet" ? "•" : "%1."}"/><w:lvlJc w:val="left"/>` +
      `<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>`;
    const nums = [`<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`];
    for (let i = 0; i < this.numbered; i++) {
      nums.push(
        `<w:num w:numId="${i + 2}"><w:abstractNumId w:val="1"/>` +
          `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
      );
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W_NS}">` +
      `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>${level("bullet")}</w:abstractNum>` +
      `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>${level("decimal")}</w:abstractNum>` +
      `${nums.join("")}</w:numbering>`;
  }

  private runs(runs: Run[]): string {
    return runs.map((r) => this.run(r)).join("");
  }

  private run(run: Run): string {
    // Order matters in OOXML: b, i, then color.
    const props = [run.bold ? "<w:b/>" : "", run.italic ? "<w:i/>" : "", run.color ? `<w:color w:val="${run.color}"/>` : ""].join("");
    const rPr = props ? `<w:rPr>${props}</w:rPr>` : "";
    const text = xmlSafe(run.text);
    // xml:space="preserve" keeps leading/trailing spaces (e.g. "Label: ").
    const r = `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
    if (!/^https?:\/\/\S+$/.test(text.trim())) return r;
    // A bare URL becomes a clickable link.
    const id = this.links.push(text.trim()) - 1;
    const linkProps = `<w:rPr><w:rStyle w:val="Hyperlink"/>${props}</w:rPr>`;
    return `<w:hyperlink r:id="rIdLink${id}"><w:r>${linkProps}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:hyperlink>`;
  }

  private para(content: string, pPr = ""): string {
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${content}</w:p>`;
  }

  private block(b: Block): string {
    switch (b.type) {
      case "heading":
        return this.para(this.run({ text: b.text }), `<w:pStyle w:val="Heading${b.level}"/>`);
      case "paragraph":
        return this.para(this.runs(b.runs));
      case "list": {
        const numId = b.ordered ? ++this.numbered + 1 : 1;
        return b.items
          .map((item) =>
            this.para(this.runs(item), `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`),
          )
          .join("");
      }
      case "table": {
        const col = Math.floor(TEXT_WIDTH / Math.max(1, b.header.length));
        const cell = (text: string, bold: boolean) =>
          `<w:tc><w:tcPr><w:tcW w:w="${col}" w:type="dxa"/></w:tcPr>${this.para(this.run({ text, bold }))}</w:tc>`;
        const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`;
        return (
          `<w:tbl><w:tblPr><w:tblW w:w="${TEXT_WIDTH}" w:type="dxa"/>` +
          `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders>` +
          `<w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
          `<w:tblGrid>${b.header.map(() => `<w:gridCol w:w="${col}"/>`).join("")}</w:tblGrid>` +
          `<w:tr>${b.header.map((h) => cell(h, true)).join("")}</w:tr>` +
          b.rows.map((row) => `<w:tr>${row.map((c) => cell(c, false)).join("")}</w:tr>`).join("") +
          `</w:tbl>` +
          // Word needs a paragraph between a table and whatever follows it.
          this.para("")
        );
      }
      case "quote":
        return (
          this.para(this.run({ text: `“${b.text}”`, italic: true }), `<w:pStyle w:val="Quote"/>`) +
          this.para(this.run({ text: `— ${b.attribution}` }), `<w:pStyle w:val="QuoteAttribution"/>`)
        );
      case "rule":
        return this.para("", `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr>`);
    }
  }
}

/** An inline picture of `image` (relationship `relId`), scaled to fit within maxW × maxH inches. */
function picture(relId: string, id: number, image: LogoImage, maxW: number, maxH: number): string {
  const [w, h] = fitInside(image.width, image.height, maxW, maxH);
  const cx = Math.round(w * EMU_PER_INCH);
  const cy = Math.round(h * EMU_PER_INCH);
  return (
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${id}" name="Logo ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="${PIC_NS}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}

/** A run of plain text with optional size (half-points), bold and color. */
function textRun(text: string, opts: { size?: number; bold?: boolean; color?: string } = {}): string {
  const props = [
    opts.bold ? "<w:b/>" : "",
    opts.color ? `<w:color w:val="${opts.color}"/>` : "",
    opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : "",
  ].join("");
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(xmlSafe(text))}</w:t></w:r>`;
}

/** A field such as PAGE or NUMPAGES, showing `placeholder` until Word updates it. */
const field = (code: string, placeholder: string, size: number, color: string) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r>` +
  `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${textRun(placeholder, { size, color })}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;

/** The cover page, ending in a page break. */
function coverXml(cover: CoverPage, logo: LogoImage | undefined): string {
  const centered = (content: string, after: number) =>
    `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="${after}"/></w:pPr>${content}</w:p>`;
  return [
    `<w:p><w:pPr><w:spacing w:before="2400" w:after="0"/></w:pPr></w:p>`,
    logo ? centered(picture("rIdLogo", 1, logo, 3.5, 1.75), 600) : "",
    cover.show ? centered(textRun(cover.show, { size: 56, bold: true }), 240) : "",
    centered(textRun(cover.kind, { size: 32, color: "595959" }), 480),
    cover.title ? centered(textRun(cover.title, { size: 28 }), 240) : "",
    centered(textRun(cover.date, { size: 22, color: "595959" }), 0),
    `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`,
  ].join("");
}

/** A header or footer line: something on the left, something on the right. */
function sideBySide(tag: "hdr" | "ftr", left: string, right: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:${tag} ${PART_NS}>` +
    `<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="${TEXT_WIDTH}"/></w:tabs><w:spacing w:after="0"/></w:pPr>` +
    `${left}<w:r><w:tab/></w:r>${right}</w:p></w:${tag}>`
  );
}

function headerXml(b: DocBranding): string {
  const logo = b.headerLogo && b.logo ? picture("rIdHeaderLogo", 2, b.logo, 1.75, 0.45) : "";
  return sideBySide("hdr", logo, b.headerText ? textRun(b.headerText, { size: 18, color: "595959" }) : "");
}

function footerXml(b: DocBranding): string {
  const grey = { size: 18, color: "595959" };
  const pages = b.pageNumbers
    ? textRun("Page ", grey) + field("PAGE", "1", 18, "595959") + textRun(" of ", grey) + field("NUMPAGES", "1", 18, "595959")
    : "";
  return sideBySide("ftr", b.footerText ? textRun(b.footerText, grey) : "", pages);
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="40"/><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="0"/><w:ind w:left="567"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="QuoteAttribution"><w:name w:val="Quote Attribution"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;

const contentTypes = (extra: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
${extra}</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/**
 * Build a .docx file (as bytes) from document blocks, with an optional cover
 * page, header and footer. The cover page has no header or footer.
 */
export function buildDocx(blocks: Block[], branding?: DocBranding): Uint8Array {
  const writer = new DocWriter();
  const cover = branding?.cover ? coverXml(branding.cover, branding.logo) : "";
  const body = writer.body(blocks);
  const header = branding && hasHeader(branding) ? branding : undefined;
  const footer = branding && hasFooter(branding) ? branding : undefined;
  const imageRel = (id: string) => `<Relationship Id="${id}" Type="${REL}/image" Target="media/logo.png"/>`;
  const extraRels = [
    cover && branding?.logo ? imageRel("rIdLogo") : "",
    header ? `<Relationship Id="rIdHeader" Type="${REL}/header" Target="header1.xml"/>` : "",
    footer ? `<Relationship Id="rIdFooter" Type="${REL}/footer" Target="footer1.xml"/>` : "",
  ].filter(Boolean);
  // Order matters in sectPr: header/footer references first, titlePg after the page setup.
  const sectPr =
    `<w:sectPr>` +
    (header ? `<w:headerReference w:type="default" r:id="rIdHeader"/>` : "") +
    (footer ? `<w:footerReference w:type="default" r:id="rIdFooter"/>` : "") +
    `<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>` +
    // A distinct (empty) first-page header and footer keep the cover clean.
    (cover ? `<w:titlePg/>` : "") +
    `</w:sectPr>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${PART_NS}><w:body>${cover}${body}${sectPr}</w:body></w:document>`;

  const parts: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      contentTypes(
        (header ? `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` : "") +
          (footer ? `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>` : ""),
      ),
    ),
    "_rels/.rels": strToU8(ROOT_RELS),
    "word/document.xml": strToU8(documentXml),
    "word/styles.xml": strToU8(STYLES),
    "word/numbering.xml": strToU8(writer.numbering()),
    "word/_rels/document.xml.rels": strToU8(writer.relationships(extraRels)),
  };
  if (branding?.logo && (cover || header?.headerLogo)) parts["word/media/logo.png"] = branding.logo.png;
  if (header) {
    parts["word/header1.xml"] = strToU8(headerXml(header));
    if (header.headerLogo) {
      parts["word/_rels/header1.xml.rels"] = strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${imageRel("rIdHeaderLogo")}</Relationships>`,
      );
    }
  }
  if (footer) parts["word/footer1.xml"] = strToU8(footerXml(footer));
  return zipSync(parts);
}
