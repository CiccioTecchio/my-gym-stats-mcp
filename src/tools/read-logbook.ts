import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import { createGoogleDriveGateway } from "../lib/google-drive.js";
import {
  readEntireLogbook,
  readLogbookMonth,
  readLogbookYear,
  type LogbookGateways,
  type LogbookReadResult,
} from "../lib/logbook-reader.js";
import { createGoogleSheetsGateway } from "../lib/google-sheets.js";

const cellValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
const worksheetSchema = z.object({
  title: z.string(),
  values: z.array(z.array(cellValueSchema)),
});
const spreadsheetSchema = z.object({
  title: z.string(),
  fileName: z.string(),
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  worksheets: z.array(worksheetSchema),
  cellCount: z.number().int().nonnegative(),
});
const outputSchema = z.object({
  spreadsheetCount: z.number().int().nonnegative(),
  cellCount: z.number().int().nonnegative(),
  spreadsheets: z.array(spreadsheetSchema),
});
const yearSchema = z.number().int().min(1900).max(2100);
const toolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function registerReadLogbookTools(server: McpServer): void {
  const gateways: LogbookGateways = {
    drive: createGoogleDriveGateway(),
    sheets: createGoogleSheetsGateway(),
  };

  server.registerTool(
    "read_logbook_month",
    {
      title: "Read one logbook month",
      description:
        "Read every worksheet from the single monthly logbook spreadsheet selected by year and month. File IDs, paths, URLs, and ranges are resolved and restricted by the server.",
      inputSchema: z
        .object({
          year: yearSchema.describe("Four-digit logbook year"),
          month: z
            .number()
            .int()
            .min(1)
            .max(12)
            .describe("Calendar month number from 1 to 12"),
        })
        .strict(),
      outputSchema,
      annotations: toolAnnotations,
    },
    async ({ year, month }) =>
      executeRead(
        () => readLogbookMonth(gateways, year, month),
        `logbook month ${year}-${String(month).padStart(2, "0")}`,
      ),
  );

  server.registerTool(
    "read_logbook_year",
    {
      title: "Read one logbook year",
      description:
        "Read every worksheet from all monthly spreadsheets in one logbook year. The year folder and spreadsheet IDs are resolved and restricted by the server.",
      inputSchema: z
        .object({
          year: yearSchema.describe("Four-digit logbook year"),
        })
        .strict(),
      outputSchema,
      annotations: toolAnnotations,
    },
    async ({ year }) =>
      executeRead(
        () => readLogbookYear(gateways, year),
        `logbook year ${year}`,
      ),
  );

  server.registerTool(
    "read_entire_logbook",
    {
      title: "Read the entire logbook",
      description:
        "Read every worksheet from every valid monthly spreadsheet under all YYYY folders in the configured logbook. No path, file ID, URL, or range can be supplied by the caller.",
      inputSchema: z.object({}).strict(),
      outputSchema,
      annotations: toolAnnotations,
    },
    async () =>
      executeRead(() => readEntireLogbook(gateways), "the entire logbook"),
  );
}

async function executeRead(
  read: () => Promise<LogbookReadResult>,
  scopeDescription: string,
) {
  try {
    const result = await read();

    return {
      content: [
        {
          type: "text" as const,
          text: `Read ${result.spreadsheetCount} spreadsheet(s) and ${result.cellCount} populated cell(s) from ${scopeDescription}. The complete data is available in structuredContent.`,
        },
      ],
      structuredContent: result,
    };
  } catch (error: unknown) {
    console.error(`Unable to read ${scopeDescription}:`, error);

    return {
      content: [
        {
          type: "text" as const,
          text: `Unable to read ${scopeDescription}. Check that the requested period exists, the Google Sheets API is enabled, and the service account has access.`,
        },
      ],
      isError: true,
    };
  }
}
