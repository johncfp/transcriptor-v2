/**
 * Branding as the document writers see it: the Word and PDF writers draw the
 * cover page, header and footer from this. Pure, so tests can build one.
 */

export interface LogoImage {
  png: Uint8Array;
  /** Pixel size, for the aspect ratio. */
  width: number;
  height: number;
}

export interface Logo extends LogoImage {
  /** A copy 120px tall, for page headers in PDFs. */
  small: LogoImage;
}

/** Branding for every document in one export. */
export interface ExportBranding {
  coverPage: boolean;
  show: string;
  /** The export date as it appears on the cover, e.g. "September 29, 2026". */
  date: string;
  logo?: Logo;
  logoInHeader: boolean;
  headerText: string;
  footerText: string;
  pageNumbers: boolean;
}

export interface CoverPage {
  show: string;
  /** "Transcript", "Show Notes" or "Reference". */
  kind: string;
  title: string;
  date: string;
}

/** Branding for one document. */
export interface DocBranding {
  cover?: CoverPage;
  logo?: Logo;
  /** The logo in the header (only when there is one). */
  headerLogo: boolean;
  headerText: string;
  footerText: string;
  pageNumbers: boolean;
}

export function docBranding(b: ExportBranding, kind: string, title: string): DocBranding {
  return {
    cover: b.coverPage ? { show: b.show, kind, title, date: b.date } : undefined,
    logo: b.logo,
    headerLogo: b.logoInHeader && !!b.logo,
    headerText: b.headerText.trim(),
    footerText: b.footerText.trim(),
    pageNumbers: b.pageNumbers,
  };
}

export const hasHeader = (b: DocBranding) => b.headerLogo || b.headerText !== "";
export const hasFooter = (b: DocBranding) => b.footerText !== "" || b.pageNumbers;

/** The cover as plain lines, for text exports. */
export function coverLines(c: CoverPage): string[] {
  return [c.show, c.kind, c.title, c.date].filter((s) => s.trim() !== "");
}

/** Scale a width × height box to fit inside maxW × maxH, keeping its shape. */
export function fitInside(width: number, height: number, maxW: number, maxH: number): [number, number] {
  const scale = Math.min(maxW / Math.max(1, width), maxH / Math.max(1, height));
  return [width * scale, height * scale];
}
