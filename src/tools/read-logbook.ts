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

/**
 * Registers the three read-only logbook content tools on an MCP server.
 *
 * @param server - MCP server that will expose `read_logbook_month`,
 * `read_logbook_year`, and `read_entire_logbook`.
 * @returns Nothing. The function mutates the server's tool registry.
 * @remarks Month input is a strict `{ year, month }` object, year input is a
 * strict `{ year }` object, and the full-logbook tool accepts a strict empty
 * object. Successful calls return a short text summary plus structured
 * `LogbookReadResult` data. Zod rejects malformed MCP input before a handler is
 * invoked; operational errors are converted by `executeRead` to `isError` MCP
 * results instead of being propagated to the client.
 * @security Callers can select only a validated logical period. They cannot
 * provide paths, Drive IDs, spreadsheet IDs, URLs, queries, worksheet names, or
 * ranges. The underlying gateways are read-only, discovery is confined to the
 * configured logbook hierarchy, and lower layers enforce response-size limits.
 */
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

/**
 * Executes a logbook read and converts its outcome into an MCP tool result.
 *
 * @param read - Deferred month, year, or complete-logbook read operation.
 * @param scopeDescription - Server-generated label used in the response and
 * diagnostic log; it must not contain untrusted secrets.
 * @returns A successful MCP result containing a text summary and structured
 * logbook data, or an `isError: true` result with a generic remediation message.
 * @remarks All exceptions from `read` are caught. Detailed Google and internal
 * errors are written only to the server log so credentials, IDs, and backend
 * implementation details are not deliberately returned to the model.
 */
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
