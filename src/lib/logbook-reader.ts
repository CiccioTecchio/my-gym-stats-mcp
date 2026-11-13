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

export async function readEntireLogbook(
  gateways: LogbookGateways,
): Promise<LogbookReadResult> {
  const index = await getLogbookIndex(gateways.drive);

  if (index.length === 0) {
    throw new Error("No logbook spreadsheets were found.");
  }

  return readIndexedFiles(gateways.sheets, index);
}

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

function validateYear(year: number): void {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    throw new Error("Year must be an integer between 1900 and 2100.");
  }
}

function validateYearAndMonth(year: number, month: number): void {
  validateYear(year);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("Month must be an integer between 1 and 12.");
  }
}

function padMonth(month: number): string {
  return String(month).padStart(2, "0");
}
