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
  getSpreadsheetMetadata(spreadsheetId: string): Promise<SpreadsheetMetadata>;
  batchGetValues(
    spreadsheetId: string,
    ranges: string[],
  ): Promise<SpreadsheetValues>;
}

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

function toWholeWorksheetRange(title: string): string {
  return `'${title.replaceAll("'", "''")}'`;
}

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
