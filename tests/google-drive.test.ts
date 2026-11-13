import assert from "node:assert/strict";
import test from "node:test";

import {
  getLogbookFolderId,
  listLogbookFiles,
  type DriveGateway,
} from "../src/lib/google-drive.js";

const LOGBOOK_FOLDER_ID = "safe_logbook_folder_123";

test("traverses only YYYY folders and lists their direct spreadsheets", async () => {
  const receivedTokens: Array<string | undefined> = [];
  const receivedQueries: string[] = [];
  const gateway: DriveGateway = {
    async getFile(fileId) {
      assert.equal(fileId, LOGBOOK_FOLDER_ID);

      return {
        id: LOGBOOK_FOLDER_ID,
        name: "logbook",
        mimeType: "application/vnd.google-apps.folder",
        trashed: false,
      };
    },
    async listFiles({ query, pageToken }) {
      receivedQueries.push(query);
      receivedTokens.push(pageToken);

      if (query.startsWith(`'${LOGBOOK_FOLDER_ID}' in parents`)) {
        return {
          files: [
            {
              id: "year_2025",
              name: "2025",
              mimeType: "application/vnd.google-apps.folder",
            },
            {
              id: "year_2026",
              name: "2026",
              mimeType: "application/vnd.google-apps.folder",
            },
            {
              id: "not_a_year",
              name: "archive",
              mimeType: "application/vnd.google-apps.folder",
            },
          ],
        };
      }

      if (query.startsWith("'year_2025' in parents")) {
        return {
          files: [
            {
              id: "sheet_1",
              name: "October",
              mimeType: "application/vnd.google-apps.spreadsheet",
              modifiedTime: "2025-10-31T10:00:00.000Z",
            },
          ],
        };
      }

      if (query.startsWith("'year_2026' in parents") && !pageToken) {
        return {
          files: [
            {
              id: "sheet_2",
              name: "January",
              mimeType: "application/vnd.google-apps.spreadsheet",
            },
          ],
          nextPageToken: "next_page",
        };
      }

      if (query.startsWith("'year_2026' in parents")) {
        return {
          files: [
            {
              id: "sheet_3",
              name: "February",
              mimeType: "application/vnd.google-apps.spreadsheet",
              webViewLink: "https://docs.google.com/spreadsheets/d/sheet_3",
            },
          ],
        };
      }

      assert.fail(`Unexpected Drive query: ${query}`);
    },
  };

  const files = await listLogbookFiles(gateway, LOGBOOK_FOLDER_ID);

  assert.equal(files.length, 3);
  assert.deepEqual(
    files.map(({ year, name }) => ({ year, name })),
    [
      { year: "2025", name: "October" },
      { year: "2026", name: "January" },
      { year: "2026", name: "February" },
    ],
  );
  assert.deepEqual(receivedTokens, [undefined, undefined, undefined, "next_page"]);
  assert.match(receivedQueries[0] ?? "", /^'safe_logbook_folder_123' in parents/);
  assert.match(
    receivedQueries[0] ?? "",
    /mimeType = 'application\/vnd\.google-apps\.folder'/,
  );
  assert.equal(receivedQueries.some((query) => query.includes("not_a_year")), false);
  for (const query of receivedQueries.slice(1)) {
    assert.match(query, /^'year_20(?:25|26)' in parents/);
    assert.match(
      query,
      /mimeType = 'application\/vnd\.google-apps\.spreadsheet'/,
    );
  }
});

test("rejects an unsafe folder ID before calling Google Drive", async () => {
  let called = false;
  const gateway: DriveGateway = {
    async getFile() {
      called = true;
      return {};
    },
    async listFiles() {
      called = true;
      return {};
    },
  };

  await assert.rejects(
    listLogbookFiles(gateway, "folder' or trashed = false"),
    /folder ID is invalid/,
  );
  assert.equal(called, false);
});

test("rejects a configured folder that is not the logbook", async () => {
  const gateway: DriveGateway = {
    async getFile() {
      return {
        id: LOGBOOK_FOLDER_ID,
        name: "private-files",
        mimeType: "application/vnd.google-apps.folder",
        trashed: false,
      };
    },
    async listFiles() {
      assert.fail("files.list must not run for the wrong folder");
    },
  };

  await assert.rejects(
    listLogbookFiles(gateway, LOGBOOK_FOLDER_ID),
    /active folder named "logbook"/,
  );
});

test("reads the folder ID only from the server environment", () => {
  assert.equal(
    getLogbookFolderId({
      GOOGLE_DRIVE_LOGBOOK_FOLDER_ID: `  ${LOGBOOK_FOLDER_ID}  `,
    }),
    LOGBOOK_FOLDER_ID,
  );
  assert.throws(
    () =>
      getLogbookFolderId({
        GOOGLE_DRIVE_LOGBOOK_FOLDER_ID: "../../another-folder",
      }),
    /not a valid Drive ID/,
  );
});
