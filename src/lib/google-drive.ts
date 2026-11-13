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
  /**
   * Retrieves the minimum metadata required to validate the configured root.
   *
   * @param fileId - Google Drive ID of the item to inspect.
   * @returns Metadata for the requested Drive item.
   * @throws Rejects with Google authentication, authorization, quota, network,
   * or not-found errors returned by the Drive API.
   */
  getFile(fileId: string): Promise<DriveFolderMetadata>;

  /**
   * Lists one page of Drive items matching a server-generated query.
   *
   * @param params - Parent-constrained query and optional pagination token.
   * @returns A page of file metadata and, when present, the next page token.
   * @throws Rejects with errors returned by the Drive API.
   */
  listFiles(params: {
    query: string;
    pageToken?: string;
  }): Promise<DriveFileListPage>;
}

/**
 * Reads and validates the server-controlled root folder ID.
 *
 * @param environment - Environment variables to inspect. Defaults to
 * `process.env`; accepting an explicit object keeps the function testable.
 * @returns The trimmed `GOOGLE_DRIVE_LOGBOOK_FOLDER_ID` value.
 * @throws When the variable is missing or empty, because the server would not
 * have a trusted root from which to start discovery.
 * @throws When the value contains characters outside the Drive ID allowlist or
 * is longer than 256 characters. This prevents malformed IDs and query
 * injection when the value is interpolated into Drive search expressions.
 */
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

/**
 * Creates the production Google Drive adapter using Application Default
 * Credentials and the metadata-only read scope.
 *
 * @returns A gateway that can inspect file metadata and execute paginated file
 * listings. It cannot read file contents or modify Drive data because it uses
 * `drive.metadata.readonly`.
 * @remarks Calls made through the returned gateway reject with the Google API
 * authentication, authorization, quota, network, and validation errors they
 * receive.
 */
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

/**
 * Discovers monthly spreadsheets inside the configured logbook hierarchy.
 *
 * @param gateway - Drive adapter used for metadata lookups and listings.
 * @param folderId - Server-configured ID of the expected `logbook` root.
 * @returns Metadata for direct Google Spreadsheet children of direct `YYYY`
 * folders, including the year inherited from the validated parent folder.
 * @throws When `folderId` does not match the Drive ID allowlist.
 * @throws When the root is missing, trashed, not a folder, or not named
 * `logbook`, because discovery must remain anchored to the intended root.
 * @throws When Drive returns a malformed year-folder ID, because it cannot be
 * safely embedded in the next parent query.
 * @throws When a directory or the complete result exceeds
 * `MAX_LOGBOOK_FILES`, limiting memory use and unexpectedly broad traversal.
 * @throws Propagates authentication, authorization, quota, network, and other
 * errors produced by the supplied gateway.
 * @security Callers cannot provide descendant paths or arbitrary queries. The
 * function visits only direct folders whose names match `YYYY`, then only
 * direct, non-trashed Google Spreadsheet children. All IDs interpolated into
 * Drive queries are allowlist-validated.
 */
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

/**
 * Collects every page for one internally constructed Drive query.
 *
 * @param gateway - Drive adapter used to request each page.
 * @param query - Parent- and MIME-constrained query built by
 * `listLogbookFiles`; it must not contain unvalidated caller input.
 * @returns All file metadata returned across the paginated response.
 * @throws When accumulated results exceed `MAX_LOGBOOK_FILES`, preventing
 * excessive memory consumption and unbounded traversal.
 * @throws Propagates any error from `gateway.listFiles`, including Google API
 * authentication, authorization, quota, and network failures.
 */
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
