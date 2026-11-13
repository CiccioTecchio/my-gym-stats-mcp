import assert from "node:assert/strict";
import test from "node:test";

import {
  readSpreadsheet,
  type SheetsGateway,
} from "../src/lib/google-sheets.js";

test("reads all worksheets and safely escapes worksheet titles", async () => {
  let receivedRanges: string[] = [];
  const gateway: SheetsGateway = {
    async getSpreadsheetMetadata(spreadsheetId) {
      assert.equal(spreadsheetId, "safe_sheet_123");
      return {
        title: "Logbook01_25",
        worksheets: [
          { index: 0, title: "Session 1" },
          { index: 1, title: "Coach's notes" },
        ],
      };
    },
    async batchGetValues(spreadsheetId, ranges) {
      assert.equal(spreadsheetId, "safe_sheet_123");
      receivedRanges = ranges;
      return {
        valueRanges: [
          { values: [["Exercise", "Weight"], ["Squat", 100]] },
          { values: [["Good session", true]] },
        ],
      };
    },
  };

  const result = await readSpreadsheet(gateway, "safe_sheet_123");

  assert.deepEqual(receivedRanges, ["'Session 1'", "'Coach''s notes'"]);
  assert.equal(result.title, "Logbook01_25");
  assert.equal(result.worksheets.length, 2);
  assert.equal(result.cellCount, 6);
});

test("rejects an unsafe spreadsheet ID before calling Google Sheets", async () => {
  let called = false;
  const gateway: SheetsGateway = {
    async getSpreadsheetMetadata() {
      called = true;
      return { worksheets: [] };
    },
    async batchGetValues() {
      called = true;
      return {};
    },
  };

  await assert.rejects(
    readSpreadsheet(gateway, "../../another-sheet"),
    /spreadsheet ID is invalid/,
  );
  assert.equal(called, false);
});
