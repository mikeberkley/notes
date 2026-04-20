import { insertRawSource, getConfig } from '../db/queries.js';

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

async function extractText(file: DriveFile, accessToken: string): Promise<string> {
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
    file.mimeType === 'application/msword' ||
    file.mimeType === 'application/pdf'
  ) {
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (resp.ok) return resp.text();
    // Drive export only works for Google Workspace files; native binary files can't be decoded as text
    console.warn(`[gdrive] Skipping ${file.name} (${file.mimeType}): export to text/plain not supported`);
    return '';
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

export async function ingestGDrive(
  db: D1Database,
  accessToken: string,
  userId: string,
  date: string, // YYYY-MM-DD
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
  console.log(`[gdrive] Found ${files.length} file(s) modified on or after ${modifiedAfter}`);

  for (const file of files) {
    try {
      const content = await extractText(file, accessToken);
      if (!content.trim()) continue;

      const metadata = { filename: file.name, mime_type: file.mimeType, modified_time: file.modifiedTime, folder_path: file.folderPath };
      const externalId = `${file.id}::${file.modifiedTime}`;
      await insertRawSource(db, userId, 'gdrive', externalId, content, metadata, date);
    } catch (err) {
      console.error(`Drive file ${file.id} error:`, err);
    }
  }
}
