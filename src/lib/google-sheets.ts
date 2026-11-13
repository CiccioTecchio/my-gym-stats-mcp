import { auth, sheets } from "@googleapis/sheets";

const SPREADSHEETS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/spreadsheets.readonly";
const SAFE_SPREADSHEET_ID = /^[A-Za-z0-9_-]{1,256}$/;

export type CellValue = string | number | boolean | null;

export interface WorksheetData {
  title: string;
  values: CellValue[][];
}

export interface SpreadsheetData {
  title: string;
  worksheets: WorksheetData[];
  cellCount: number;
}

interface SpreadsheetMetadata {
  title?: string | null;
  worksheets: Array<{
    index: number;
    title: string;
  }>;
}

interface SpreadsheetValues {
  valueRanges?: Array<{
    values?: unknown[][] | null;
  }>;
}

export interface SheetsGateway {
  /**
   * Reads spreadsheet and worksheet metadata without loading grid data.
   *
   * @param spreadsheetId - Validated ID of the spreadsheet to inspect.
   * @returns The spreadsheet title and ordered GRID worksheet titles.
   * @throws Rejects with Google authentication, authorization, quota, network,
   * or not-found errors returned by the Sheets API.
   */
  getSpreadsheetMetadata(spreadsheetId: string): Promise<SpreadsheetMetadata>;

  /**
   * Reads multiple worksheet ranges in one Sheets API request.
   *
   * @param spreadsheetId - Validated ID of the spreadsheet to read.
   * @param ranges - Server-generated and escaped A1 worksheet ranges.
   * @returns Value ranges in the same order as the requested ranges.
   * @throws Rejects with errors returned by the Sheets API.
   */
  batchGetValues(
    spreadsheetId: string,
    ranges: string[],
  ): Promise<SpreadsheetValues>;
}

/**
 * Creates the production Google Sheets adapter using Application Default
 * Credentials and the read-only spreadsheets scope.
 *
 * @returns A gateway that can read spreadsheet metadata and values but cannot
 * modify Google Sheets data.
 * @remarks Calls made through the returned gateway reject with Google API
 * authentication, authorization, quota, network, and validation errors.
 */
export function createGoogleSheetsGateway(): SheetsGateway {
  const googleAuth = new auth.GoogleAuth({
    scopes: [SPREADSHEETS_READONLY_SCOPE],
  });
  const sheetsClient = sheets({ version: "v4", auth: googleAuth });

  return {
    async getSpreadsheetMetadata(spreadsheetId) {
      const response = await sheetsClient.spreadsheets.get({
        spreadsheetId,
        fields:
          "properties(title),sheets(properties(index,sheetType,title))",
        includeGridData: false,
      });

      return {
        title: response.data.properties?.title,
        worksheets: (response.data.sheets ?? [])
          .filter(
            (sheet) =>
              (sheet.properties?.sheetType === undefined ||
                sheet.properties?.sheetType === null ||
                sheet.properties?.sheetType === "GRID") &&
              typeof sheet.properties?.title === "string",
          )
          .map((sheet) => ({
            index: sheet.properties?.index ?? 0,
            title: sheet.properties?.title ?? "",
          }))
          .sort((left, right) => left.index - right.index),
      };
    },

    async batchGetValues(spreadsheetId, ranges) {
      const response = await sheetsClient.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges,
        majorDimension: "ROWS",
        valueRenderOption: "FORMATTED_VALUE",
      });

      return response.data;
    },
  };
}

/**
 * Reads every GRID worksheet from a spreadsheet discovered by the server.
 *
 * @param gateway - Sheets adapter used for metadata and value requests.
 * @param spreadsheetId - Drive-discovered spreadsheet ID. It is never accepted
 * directly from an MCP caller.
 * @returns The spreadsheet title, ordered worksheets, normalized cell values,
 * and total number of populated cells. A spreadsheet with no GRID worksheets
 * returns an empty `worksheets` array and a zero cell count.
 * @throws When `spreadsheetId` fails the strict ID allowlist, preventing unsafe
 * or malformed identifiers from reaching Google APIs.
 * @throws Propagates metadata and value-read errors from the gateway, including
 * authentication, authorization, quota, network, and not-found failures.
 * @security Worksheet names come only from Sheets metadata and are escaped
 * before becoming A1 ranges. Values are normalized to JSON-safe primitive
 * types, and the production gateway uses `spreadsheets.readonly`.
 */
export async function readSpreadsheet(
  gateway: SheetsGateway,
  spreadsheetId: string,
): Promise<SpreadsheetData> {
  if (!SAFE_SPREADSHEET_ID.test(spreadsheetId)) {
    throw new Error("The discovered spreadsheet ID is invalid.");
  }

  const metadata = await gateway.getSpreadsheetMetadata(spreadsheetId);
  const worksheetTitles = metadata.worksheets.map(({ title }) => title);

  if (worksheetTitles.length === 0) {
    return {
      title: metadata.title ?? "Untitled spreadsheet",
      worksheets: [],
      cellCount: 0,
    };
  }

  const ranges = worksheetTitles.map(toWholeWorksheetRange);
  const response = await gateway.batchGetValues(spreadsheetId, ranges);
  let cellCount = 0;
  const worksheets = worksheetTitles.map((title, index) => {
    const values = (response.valueRanges?.[index]?.values ?? []).map((row) =>
      row.map(normalizeCellValue),
    );
    cellCount += values.reduce((total, row) => total + row.length, 0);

    return { title, values };
  });

  return {
    title: metadata.title ?? "Untitled spreadsheet",
    worksheets,
    cellCount,
  };
}

/**
 * Converts a worksheet title into a quoted whole-sheet A1 range.
 *
 * @param title - Worksheet title returned by Google Sheets metadata.
 * @returns A single-quoted A1 range with embedded apostrophes doubled.
 * @security Escaping prevents a worksheet title from changing the intended A1
 * range syntax.
 */
function toWholeWorksheetRange(title: string): string {
  return `'${title.replaceAll("'", "''")}'`;
}

/**
 * Restricts an arbitrary API cell value to the MCP output schema.
 *
 * @param value - Raw value returned by the Sheets gateway.
 * @returns `null`, a string, number, or boolean. Unexpected values are safely
 * stringified instead of being returned as nested objects.
 */
function normalizeCellValue(value: unknown): CellValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  return String(value);
}
