/**
 * The uploaded file's own name, cleaned up for storing and showing.
 *
 * Multer (busboy) decodes the name as Latin-1, which garbles anything
 * non-ASCII ("ब्रोशर.pdf"), so it's re-decoded as UTF-8 — keeping the name
 * as it came when it wasn't UTF-8 to begin with. Browsers send a bare name,
 * but any path is stripped anyway.
 */
export function uploadedFileName(file: Express.Multer.File, maxLength = 150): string {
  const utf8 = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const name = (utf8.includes('�') ? file.originalname : utf8).split(/[\\/]/).pop()?.trim() ?? '';
  // Trim from the front so the extension survives.
  return name.slice(-maxLength) || 'file';
}

/** `attachment`/`inline` header value that survives non-ASCII file names. */
export function contentDisposition(type: 'inline' | 'attachment', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
