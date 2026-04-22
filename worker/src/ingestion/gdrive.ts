import type { Env } from '../types.js';
import { insertRawSource, getConfig } from '../db/queries.js';
import { callLLMWithPDF } from '../llm/openrouter.js';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  folderPath: string; // slash-separated path of ancestor folders relative to the configured root
}

async function exportGoogleDoc(fileId: string, accessToken: string): Promise<string> {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) return '';
  return resp.text();
}

async function downloadFile(fileId: string, accessToken: string): Promise<ArrayBuffer> {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) return new ArrayBuffer(0);
  return resp.arrayBuffer();
}

// Max PDF size to send to the LLM (10 MB raw ≈ 13 MB base64, well within model limits)
const MAX_PDF_BYTES = 10 * 1024 * 1024;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode(...(bytes.subarray(i, i + chunkSize) as unknown as number[]));
  }
  return btoa(binary);
}

async function extractText(file: DriveFile, accessToken: string, env: Env): Promise<string> {
  if (
    file.mimeType === 'application/vnd.google-apps.document' ||
    file.mimeType === 'application/vnd.google-apps.presentation'
  ) {
    return exportGoogleDoc(file.id, accessToken);
  }

  if (file.mimeType === 'text/plain' || file.name.endsWith('.md') || file.name.endsWith('.txt')) {
    const buf = await downloadFile(file.id, accessToken);
    return new TextDecoder().decode(buf);
  }

  if (
    file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    file.mimeType === 'application/msword'
  ) {
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (resp.ok) return resp.text();
    console.warn(`[gdrive] Skipping ${file.name} (${file.mimeType}): export to text/plain not supported`);
    return '';
  }

  if (file.mimeType === 'application/pdf') {
    const buf = await downloadFile(file.id, accessToken);
    if (buf.byteLength === 0) return '';
    if (buf.byteLength > MAX_PDF_BYTES) {
      console.warn(`[gdrive] PDF ${file.name} too large (${buf.byteLength} bytes), skipping`);
      return '';
    }
    console.log(`[gdrive] Extracting text from PDF ${file.name} (${buf.byteLength} bytes) via LLM`);
    const base64 = arrayBufferToBase64(buf);
    const extracted = await callLLMWithPDF(
      env,
      'You are a document text extractor. Extract all text content from the PDF exactly as it appears.',
      base64,
      'Extract all text from this PDF document. Preserve the structure (headings, paragraphs, bullet points, tables) as plain text. Return only the extracted text — no commentary, no preamble.',
    );
    // Sanity check: extracted text should be non-trivially long relative to PDF size.
    // Very short output from a large PDF almost certainly means the model ignored the document.
    const minExpectedChars = Math.min(200, buf.byteLength / 100);
    if (extracted.trim().length < minExpectedChars) {
      console.warn(`[gdrive] PDF extraction for ${file.name} returned suspiciously short output (${extracted.trim().length} chars from ${buf.byteLength} byte PDF) — skipping`);
      return '';
    }
    return extracted;
  }

  return '';
}

/**
 * List all files modified on or after `modifiedAfter` in `folderId` and all
 * of its sub-folders, recursively. Folders themselves are not returned.
 */
async function listFilesRecursive(
  folderId: string,
  modifiedAfter: string,
  accessToken: string,
  folderPath = '', // path from configured root to this folder, e.g. "Research" or "Work/Research"
): Promise<DriveFile[]> {
  const results: DriveFile[] = [];

  // List everything directly in this folder (files + sub-folders)
  const query = `'${folderId}' in parents and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime)&pageSize=100`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) {
    console.error(`Drive list error for folder ${folderId}:`, await resp.text());
    return results;
  }

  const data = await resp.json<{ files: Array<{ id: string; name: string; mimeType: string; modifiedTime: string }> }>();
  const items = data.files ?? [];

  for (const item of items) {
    if (item.mimeType === 'application/vnd.google-apps.folder') {
      // Recurse into sub-folder (no modifiedTime filter here — a sub-folder's
      // modifiedTime may not update when a child file is edited)
      const subPath = folderPath ? `${folderPath}/${item.name}` : item.name;
      const children = await listFilesRecursive(item.id, modifiedAfter, accessToken, subPath);
      results.push(...children);
    } else if (item.modifiedTime >= modifiedAfter) {
      results.push({ ...item, folderPath });
    }
  }

  return results;
}

/**
 * List files directly shared with the user ("Shared with me"). For any shared
 * folders, recurse into them via listFilesRecursive so we pick up their children
 * (which won't have sharedWithMe=true themselves).
 */
async function listSharedWithMeFiles(
  modifiedAfter: string,
  accessToken: string,
): Promise<DriveFile[]> {
  const results: DriveFile[] = [];

  const query = `sharedWithMe = true and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime)&pageSize=100`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) {
    console.error(`Drive sharedWithMe list error:`, await resp.text());
    return results;
  }

  const data = await resp.json<{ files: Array<{ id: string; name: string; mimeType: string; modifiedTime: string }> }>();
  const items = data.files ?? [];

  for (const item of items) {
    if (item.mimeType === 'application/vnd.google-apps.folder') {
      // Children of a shared folder don't carry sharedWithMe=true, so recurse normally
      const children = await listFilesRecursive(item.id, modifiedAfter, accessToken, item.name);
      results.push(...children);
    } else if (item.modifiedTime >= modifiedAfter) {
      results.push({ ...item, folderPath: 'Shared with me' });
    }
  }

  return results;
}

function isMeetingNotes(folderPath: string): boolean {
  return folderPath.split('/').some(s => s.toLowerCase() === 'meeting notes');
}

/**
 * Deduplicate files by name, preferring the copy in "Meeting Notes" over any
 * other location. Among equally-ranked duplicates, the first encountered wins.
 */
function deduplicateByName(files: DriveFile[]): DriveFile[] {
  const seen = new Map<string, DriveFile>();
  for (const file of files) {
    const existing = seen.get(file.name);
    if (!existing) {
      seen.set(file.name, file);
    } else if (!isMeetingNotes(existing.folderPath) && isMeetingNotes(file.folderPath)) {
      seen.set(file.name, file);
    }
  }
  return Array.from(seen.values());
}

export async function ingestGDrive(
  db: D1Database,
  accessToken: string,
  userId: string,
  date: string, // YYYY-MM-DD
  env: Env,
): Promise<void> {
  const folderId = await getConfig(db, userId, 'gdrive_folder_id');

  const modifiedAfter = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let files: DriveFile[];
  if (folderId) {
    files = await listFilesRecursive(folderId, modifiedAfter, accessToken);
  } else {
    const [myDriveFiles, sharedFiles] = await Promise.all([
      listFilesRecursive('root', modifiedAfter, accessToken),
      listSharedWithMeFiles(modifiedAfter, accessToken),
    ]);
    files = [...myDriveFiles, ...sharedFiles];
  }

  const deduplicated = deduplicateByName(files);
  if (deduplicated.length < files.length) {
    console.log(`[gdrive] Deduplicated ${files.length - deduplicated.length} file(s) by name`);
  }
  console.log(`[gdrive] Ingesting ${deduplicated.length} file(s) modified on or after ${modifiedAfter}`);

  for (const file of deduplicated) {
    try {
      const content = await extractText(file, accessToken, env);
      if (!content.trim()) continue;

      const metadata = { filename: file.name, mime_type: file.mimeType, modified_time: file.modifiedTime, folder_path: file.folderPath };
      const externalId = `${file.id}::${file.modifiedTime}`;
      await insertRawSource(db, userId, 'gdrive', externalId, content, metadata, date);
    } catch (err) {
      console.error(`Drive file ${file.id} error:`, err);
    }
  }
}
