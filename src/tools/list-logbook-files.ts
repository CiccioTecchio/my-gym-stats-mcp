import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import {
  createGoogleDriveGateway,
  getLogbookFolderId,
  listLogbookFiles,
} from "../lib/google-drive.js";

const driveFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  modifiedTime: z.string().nullable(),
  webViewLink: z.string().nullable(),
  year: z.string().regex(/^\d{4}$/),
});

const outputSchema = z.object({
  count: z.number().int().nonnegative(),
  files: z.array(driveFileSchema),
});

export function registerListLogbookFilesTool(server: McpServer): void {
  const gateway = createGoogleDriveGateway();

  server.registerTool(
    "list_logbook_files",
    {
      title: "List logbook files",
      description:
        'List the monthly Google Spreadsheets contained in YYYY year folders directly under the configured Google Drive folder named "logbook". The root folder is fixed by the server and cannot be selected by the caller.',
      inputSchema: z.object({}).strict(),
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const folderId = getLogbookFolderId();
        const files = await listLogbookFiles(gateway, folderId);
        const result = { count: files.length, files };
        const summary =
          files.length === 0
            ? "The logbook year folders contain no spreadsheets."
            : [
                `Found ${files.length} spreadsheet(s) in the logbook:`,
                ...files.map((file) => `- ${file.year}/${file.name}`),
              ].join("\n");

        return {
          content: [{ type: "text", text: summary }],
          structuredContent: result,
        };
      } catch (error: unknown) {
        console.error("Unable to list logbook files:", error);

        return {
          content: [
            {
              type: "text",
              text: "Unable to list the logbook files. Check the server's Google credentials and logbook folder configuration.",
            },
          ],
          isError: true,
        };
      }
    },
  );
}
