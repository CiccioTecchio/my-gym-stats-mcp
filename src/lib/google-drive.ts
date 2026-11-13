import { auth, drive } from "@googleapis/drive";

const DRIVE_METADATA_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.metadata.readonly";
const GOOGLE_DRIVE_FOLDER_MIME_TYPE =
  "application/vnd.google-apps.folder";
const GOOGLE_SHEETS_MIME_TYPE =
  "application/vnd.google-apps.spreadsheet";
const LOGBOOK_FOLDER_NAME = "logbook";
const MAX_LOGBOOK_FILES = 10_000;
const SAFE_DRIVE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const YEAR_FOLDER_NAME = /^\d{4}$/;

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  webViewLink: string | null;
  year: string;
}

interface DriveFolderMetadata {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  trashed?: boolean | null;
}

interface DriveFileListPage {
  files?: Array<{
    id?: string | null;
    name?: string | null;
    mimeType?: string | null;
    modifiedTime?: string | null;
    webViewLink?: string | null;
  }> | null;
  nextPageToken?: string | null;
}

export interface DriveGateway {
  getFile(fileId: string): Promise<DriveFolderMetadata>;
  listFiles(params: {
    query: string;
    pageToken?: string;
  }): Promise<DriveFileListPage>;
}

export function getLogbookFolderId(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const folderId = environment.GOOGLE_DRIVE_LOGBOOK_FOLDER_ID?.trim();

  if (!folderId) {
    throw new Error(
      "GOOGLE_DRIVE_LOGBOOK_FOLDER_ID is not configured on the server.",
    );
  }

  // Drive IDs are opaque identifiers. Restricting their character set also
  // prevents query injection if the server environment is misconfigured.
  if (!SAFE_DRIVE_ID.test(folderId)) {
    throw new Error("GOOGLE_DRIVE_LOGBOOK_FOLDER_ID is not a valid Drive ID.");
  }

  return folderId;
}

export function createGoogleDriveGateway(): DriveGateway {
  const googleAuth = new auth.GoogleAuth({
    scopes: [DRIVE_METADATA_READONLY_SCOPE],
  });
  const driveClient = drive({ version: "v3", auth: googleAuth });

  return {
    async getFile(fileId) {
      const response = await driveClient.files.get({
        fileId,
        fields: "id,name,mimeType,trashed",
        supportsAllDrives: true,
      });

      return response.data;
    },

    async listFiles({ query, pageToken }) {
      const response = await driveClient.files.list({
        q: query,
        fields:
          "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)",
        includeItemsFromAllDrives: true,
        orderBy: "name_natural",
        pageSize: 1000,
        pageToken,
        spaces: "drive",
        supportsAllDrives: true,
      });

      return response.data;
    },
  };
}

export async function listLogbookFiles(
  gateway: DriveGateway,
  folderId: string,
): Promise<DriveFileMetadata[]> {
  if (!SAFE_DRIVE_ID.test(folderId)) {
    throw new Error("The configured logbook folder ID is invalid.");
  }

  const folder = await gateway.getFile(folderId);

  if (
    folder.id !== folderId ||
    folder.name !== LOGBOOK_FOLDER_NAME ||
    folder.mimeType !== GOOGLE_DRIVE_FOLDER_MIME_TYPE ||
    folder.trashed === true
  ) {
    throw new Error(
      'The configured Drive item must be an active folder named "logbook".',
    );
  }

  // The root ID is server-controlled and validated above. Every descendant ID
  // used below is discovered from a parent-constrained Drive query and is
  // validated again before being interpolated into the next query.
  const yearFoldersQuery =
    `'${folderId}' in parents and trashed = false ` +
    `and mimeType = '${GOOGLE_DRIVE_FOLDER_MIME_TYPE}'`;
  const yearFolders = await listAllPages(gateway, yearFoldersQuery);
  const files: DriveFileMetadata[] = [];

  for (const yearFolder of yearFolders) {
    if (
      !yearFolder.id ||
      !yearFolder.name ||
      !YEAR_FOLDER_NAME.test(yearFolder.name)
    ) {
      continue;
    }

    if (!SAFE_DRIVE_ID.test(yearFolder.id)) {
      throw new Error("Google Drive returned an invalid year folder ID.");
    }

    const spreadsheetsQuery =
      `'${yearFolder.id}' in parents and trashed = false ` +
      `and mimeType = '${GOOGLE_SHEETS_MIME_TYPE}'`;
    const spreadsheets = await listAllPages(gateway, spreadsheetsQuery);

    for (const file of spreadsheets) {
      if (!file.id || !file.name || !file.mimeType) {
        continue;
      }

      files.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime ?? null,
        webViewLink: file.webViewLink ?? null,
        year: yearFolder.name,
      });

      if (files.length > MAX_LOGBOOK_FILES) {
        throw new Error(
          `The logbook folder contains more than ${MAX_LOGBOOK_FILES} files.`,
        );
      }
    }
  }

  return files;
}

async function listAllPages(
  gateway: DriveGateway,
  query: string,
): Promise<NonNullable<DriveFileListPage["files"]>> {
  const items: NonNullable<DriveFileListPage["files"]> = [];
  let pageToken: string | undefined;

  do {
    const page = await gateway.listFiles({ query, pageToken });
    items.push(...(page.files ?? []));

    if (items.length > MAX_LOGBOOK_FILES) {
      throw new Error(
        `A logbook directory contains more than ${MAX_LOGBOOK_FILES} items.`,
      );
    }

    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);

  return items;
}
