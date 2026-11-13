import type { DriveFileMetadata, DriveGateway } from "./google-drive.js";
import {
  getLogbookFolderId,
  listLogbookFiles,
} from "./google-drive.js";
import type {
  SheetsGateway,
  SpreadsheetData,
} from "./google-sheets.js";
import { readSpreadsheet } from "./google-sheets.js";

const LOGBOOK_FILE_NAME = /^Logbook(0[1-9]|1[0-2])_(\d{2}|\d{4})$/i;
const MAX_TOTAL_CELLS = 250_000;
const MAX_RESULT_CHARACTERS = 4_000_000;
const READ_CONCURRENCY = 5;

interface IndexedLogbookFile {
  id: string;
  name: string;
  year: number;
  month: number;
}

export interface LogbookSpreadsheet extends SpreadsheetData {
  fileName: string;
  year: number;
  month: number;
}

export interface LogbookReadResult {
  spreadsheetCount: number;
  cellCount: number;
  spreadsheets: LogbookSpreadsheet[];
}

export interface LogbookGateways {
  drive: DriveGateway;
  sheets: SheetsGateway;
}

/**
 * Reads the single monthly spreadsheet identified by a year and month.
 *
 * @param gateways - Restricted Drive and Sheets adapters.
 * @param year - Four-digit year between 1900 and 2100.
 * @param month - Calendar month between 1 and 12.
 * @returns The matching spreadsheet with all of its worksheets and populated
 * cell count.
 * @throws When the year or month is not an integer in the accepted range.
 * @throws When no valid spreadsheet exists for the requested period.
 * @throws Propagates configuration, hierarchy-validation, duplicate-file,
 * Google API, spreadsheet-ID, and response-size errors from lower layers.
 * @security The caller selects only a logical year and month. File IDs, paths,
 * URLs, and ranges are resolved from the server-confined logbook index.
 */
export async function readLogbookMonth(
  gateways: LogbookGateways,
  year: number,
  month: number,
): Promise<LogbookReadResult> {
  validateYearAndMonth(year, month);
  const index = await getLogbookIndex(gateways.drive);
  const file = index.find(
    (candidate) => candidate.year === year && candidate.month === month,
  );

  if (!file) {
    throw new Error(`No logbook spreadsheet found for ${year}-${padMonth(month)}.`);
  }

  return readIndexedFiles(gateways.sheets, [file]);
}

/**
 * Reads every valid monthly spreadsheet for one logbook year.
 *
 * @param gateways - Restricted Drive and Sheets adapters.
 * @param year - Four-digit year between 1900 and 2100.
 * @returns All matching monthly spreadsheets ordered by month, together with
 * aggregate spreadsheet and populated-cell counts.
 * @throws When `year` is not an integer between 1900 and 2100.
 * @throws When the validated logbook contains no spreadsheets for `year`.
 * @throws Propagates configuration, hierarchy-validation, duplicate-file,
 * Google API, spreadsheet-ID, and response-size errors from lower layers.
 * @security Only the logical year is caller-controlled; the server discovers
 * every file ID and range beneath the configured logbook root.
 */
export async function readLogbookYear(
  gateways: LogbookGateways,
  year: number,
): Promise<LogbookReadResult> {
  validateYear(year);
  const index = await getLogbookIndex(gateways.drive);
  const files = index.filter((candidate) => candidate.year === year);

  if (files.length === 0) {
    throw new Error(`No logbook spreadsheets found for ${year}.`);
  }

  return readIndexedFiles(gateways.sheets, files);
}

/**
 * Reads every valid monthly spreadsheet in the configured logbook.
 *
 * @param gateways - Restricted Drive and Sheets adapters.
 * @returns All indexed spreadsheets ordered by year and month, plus aggregate
 * spreadsheet and populated-cell counts.
 * @throws When no valid monthly spreadsheets are found.
 * @throws Propagates configuration, hierarchy-validation, duplicate-file,
 * Google API, spreadsheet-ID, and response-size errors from lower layers.
 * @security This function accepts no caller-supplied path, ID, URL, or range;
 * traversal starts exclusively from the validated server-side root folder.
 */
export async function readEntireLogbook(
  gateways: LogbookGateways,
): Promise<LogbookReadResult> {
  const index = await getLogbookIndex(gateways.drive);

  if (index.length === 0) {
    throw new Error("No logbook spreadsheets were found.");
  }

  return readIndexedFiles(gateways.sheets, index);
}

/**
 * Builds a unique, chronologically sorted index of valid logbook files.
 *
 * @param driveGateway - Restricted Drive adapter used for discovery.
 * @returns Files whose names match `LogbookMM_YY` or `LogbookMM_YYYY` and whose
 * filename year agrees with their validated `YYYY` parent folder.
 * @throws When root configuration or Drive hierarchy validation fails.
 * @throws When more than one valid spreadsheet maps to the same year and month,
 * because the requested period would otherwise be ambiguous.
 * @throws Propagates Drive API and traversal-limit errors.
 * @security Invalid filenames and year mismatches are ignored; IDs originate
 * only from parent-constrained discovery below the configured logbook root.
 */
async function getLogbookIndex(
  driveGateway: DriveGateway,
): Promise<IndexedLogbookFile[]> {
  const rootFolderId = getLogbookFolderId();
  const files = await listLogbookFiles(driveGateway, rootFolderId);
  const index = files
    .map(toIndexedLogbookFile)
    .filter((file): file is IndexedLogbookFile => file !== null)
    .sort((left, right) => left.year - right.year || left.month - right.month);
  const seen = new Set<string>();

  for (const file of index) {
    const key = `${file.year}-${padMonth(file.month)}`;
    if (seen.has(key)) {
      throw new Error(`More than one logbook spreadsheet was found for ${key}.`);
    }
    seen.add(key);
  }

  return index;
}

/**
 * Converts discovered Drive metadata into a logical logbook index entry.
 *
 * @param file - Spreadsheet metadata returned by restricted Drive traversal.
 * @returns An indexed file when its name and parent year agree, otherwise
 * `null` so unrelated or misplaced spreadsheets are excluded.
 */
function toIndexedLogbookFile(
  file: DriveFileMetadata,
): IndexedLogbookFile | null {
  const match = LOGBOOK_FILE_NAME.exec(file.name);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const fileYear = Number(file.year);
  const yearSuffix = match[2];
  if (yearSuffix !== String(fileYear) && yearSuffix !== String(fileYear).slice(-2)) {
    return null;
  }

  return {
    id: file.id,
    name: file.name,
    year: fileYear,
    month: Number(match[1]),
  };
}

/**
 * Reads a trusted list of indexed spreadsheets with bounded concurrency.
 *
 * @param sheetsGateway - Restricted Sheets adapter used to read each file.
 * @param files - Internally discovered and validated logbook index entries.
 * @returns Spreadsheet data and aggregate counts in the same order as `files`.
 * @throws When the result exceeds `MAX_TOTAL_CELLS`, limiting response size and
 * the amount of data exposed to the MCP client.
 * @throws When serialized output exceeds `MAX_RESULT_CHARACTERS`, limiting
 * memory use and oversized MCP responses.
 * @throws Propagates Sheets API and spreadsheet-ID errors from any worker.
 * @security Reads are capped at `READ_CONCURRENCY`; callers cannot inject file
 * IDs, and both cell and serialized response sizes are bounded.
 */
async function readIndexedFiles(
  sheetsGateway: SheetsGateway,
  files: IndexedLogbookFile[],
): Promise<LogbookReadResult> {
  const spreadsheets = await mapWithConcurrency(
    files,
    READ_CONCURRENCY,
    async (file): Promise<LogbookSpreadsheet> => {
      const data = await readSpreadsheet(sheetsGateway, file.id);
      return {
        ...data,
        fileName: file.name,
        year: file.year,
        month: file.month,
      };
    },
  );
  const cellCount = spreadsheets.reduce(
    (total, spreadsheet) => total + spreadsheet.cellCount,
    0,
  );
  const result = {
    spreadsheetCount: spreadsheets.length,
    cellCount,
    spreadsheets,
  };

  if (cellCount > MAX_TOTAL_CELLS) {
    throw new Error(
      `The requested logbook data exceeds the ${MAX_TOTAL_CELLS}-cell safety limit.`,
    );
  }

  if (JSON.stringify(result).length > MAX_RESULT_CHARACTERS) {
    throw new Error(
      `The requested logbook data exceeds the ${MAX_RESULT_CHARACTERS}-character safety limit.`,
    );
  }

  return result;
}

/**
 * Maps items concurrently while preserving their original order.
 *
 * @typeParam T - Input item type.
 * @typeParam R - Mapped result type.
 * @param items - Items to process.
 * @param concurrency - Maximum number of active workers. Callers provide a
 * positive, bounded constant.
 * @param mapper - Asynchronous transformation applied once to each item.
 * @returns Results aligned with the input order.
 * @throws Rejects with the first error raised by `mapper`; remaining workers
 * may already have in-flight operations when that rejection occurs.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const item = items[currentIndex];
      if (item === undefined) {
        continue;
      }
      results[currentIndex] = await mapper(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );

  return results;
}

/**
 * Validates a caller-selected logbook year.
 *
 * @param year - Candidate year.
 * @throws When the value is not an integer between 1900 and 2100, preventing
 * nonsensical or excessively broad logical lookups.
 */
function validateYear(year: number): void {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    throw new Error("Year must be an integer between 1900 and 2100.");
  }
}

/**
 * Validates a caller-selected logbook year and calendar month.
 *
 * @param year - Candidate four-digit year.
 * @param month - Candidate month number.
 * @throws When the year is invalid according to `validateYear`.
 * @throws When the month is not an integer between 1 and 12.
 */
function validateYearAndMonth(year: number, month: number): void {
  validateYear(year);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("Month must be an integer between 1 and 12.");
  }
}

/**
 * Formats a validated month for filenames, keys, and user-facing messages.
 *
 * @param month - Calendar month number.
 * @returns The month left-padded to two characters.
 */
function padMonth(month: number): string {
  return String(month).padStart(2, "0");
}
