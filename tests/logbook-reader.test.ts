import assert from "node:assert/strict";
import test from "node:test";

import type { DriveGateway } from "../src/lib/google-drive.js";
import {
  readEntireLogbook,
  readLogbookMonth,
  readLogbookYear,
  type LogbookGateways,
} from "../src/lib/logbook-reader.js";
import type { SheetsGateway } from "../src/lib/google-sheets.js";

const ROOT_FOLDER_ID = "safe_logbook_folder_123";

function createGateways(): LogbookGateways {
  const drive: DriveGateway = {
    async getFile() {
      return {
        id: ROOT_FOLDER_ID,
        name: "logbook",
        mimeType: "application/vnd.google-apps.folder",
        trashed: false,
      };
    },
    async listFiles({ query }) {
      if (query.startsWith(`'${ROOT_FOLDER_ID}' in parents`)) {
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
          ],
        };
      }

      if (query.startsWith("'year_2025' in parents")) {
        return {
          files: [
            {
              id: "sheet_2025_01",
              name: "Logbook01_25",
              mimeType: "application/vnd.google-apps.spreadsheet",
            },
            {
              id: "sheet_2025_02",
              name: "Logbook02_2025",
              mimeType: "application/vnd.google-apps.spreadsheet",
            },
            {
              id: "ignored_sheet",
              name: "Logbook03_2024",
              mimeType: "application/vnd.google-apps.spreadsheet",
            },
          ],
        };
      }

      if (query.startsWith("'year_2026' in parents")) {
        return {
          files: [
            {
              id: "sheet_2026_01",
              name: "Logbook01_26",
              mimeType: "application/vnd.google-apps.spreadsheet",
            },
          ],
        };
      }

      assert.fail(`Unexpected Drive query: ${query}`);
    },
  };
  const sheets: SheetsGateway = {
    async getSpreadsheetMetadata(spreadsheetId) {
      return {
        title: spreadsheetId,
        worksheets: [{ index: 0, title: "Training" }],
      };
    },
    async batchGetValues(spreadsheetId) {
      return { valueRanges: [{ values: [[spreadsheetId]] }] };
    },
  };

  return { drive, sheets };
}

async function withFolderId<T>(operation: () => Promise<T>): Promise<T> {
  const previousValue = process.env.GOOGLE_DRIVE_LOGBOOK_FOLDER_ID;
  process.env.GOOGLE_DRIVE_LOGBOOK_FOLDER_ID = ROOT_FOLDER_ID;

  try {
    return await operation();
  } finally {
    if (previousValue === undefined) {
      delete process.env.GOOGLE_DRIVE_LOGBOOK_FOLDER_ID;
    } else {
      process.env.GOOGLE_DRIVE_LOGBOOK_FOLDER_ID = previousValue;
    }
  }
}

test("reads one month without accepting a file ID", async () => {
  const result = await withFolderId(() =>
    readLogbookMonth(createGateways(), 2025, 2),
  );

  assert.equal(result.spreadsheetCount, 1);
  assert.equal(result.spreadsheets[0]?.fileName, "Logbook02_2025");
  assert.equal(result.spreadsheets[0]?.month, 2);
  assert.equal("id" in (result.spreadsheets[0] ?? {}), false);
});

test("reads every valid monthly spreadsheet in one year", async () => {
  const result = await withFolderId(() =>
    readLogbookYear(createGateways(), 2025),
  );

  assert.deepEqual(
    result.spreadsheets.map(({ year, month }) => ({ year, month })),
    [
      { year: 2025, month: 1 },
      { year: 2025, month: 2 },
    ],
  );
});

test("reads all valid months from every year", async () => {
  const result = await withFolderId(() =>
    readEntireLogbook(createGateways()),
  );

  assert.deepEqual(
    result.spreadsheets.map(({ year, month }) => ({ year, month })),
    [
      { year: 2025, month: 1 },
      { year: 2025, month: 2 },
      { year: 2026, month: 1 },
    ],
  );
});
