# My Gym Stats MCP

I love working out, and I have kept a logbook since I started training. It tracks my progress, including the weight lifted and the number of sets and repetitions performed.

The logbook is stored in Google Drive as a collection of Google Sheets. Each spreadsheet covers one month, with a separate tab for every training session.

This project makes that data accessible to an LLM client—ChatGPT, in my case. The client sends requests to a Node.js MCP server, which reads the logbook through the Google Sheets API and returns the requested information.

<p align="center">
  <img src="img/architecture-overview.svg" alt="My Gym Stats MCP architecture and message flow" width="100%">
</p>

## Tech Stack

| Technology                       | Role                                                |
| -------------------------------- | --------------------------------------------------- |
| **Node.js**                      | Server runtime                                      |
| **TypeScript**                   | Type-safe application code                          |
| **Model Context Protocol (MCP)** | Communication between the LLM client and the server |
| **Google Drive API**             | Restricted discovery of logbook files               |
| **Google Sheets API**            | Access to workout data stored in Google Sheets      |
| **JSON-RPC**                     | Message format used by MCP                          |

## Configuration

1. Enable the Google Drive API in your Google Cloud project.
2. Configure [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials). If you use a service account, share only the `logbook` folder with its email address.
3. Copy `.env.example` to `.env` and set:
   - `GOOGLE_APPLICATION_CREDENTIALS` to the absolute path of the credentials file.
   - `GOOGLE_DRIVE_LOGBOOK_FOLDER_ID` to the ID from the `logbook` folder URL.

The `list_logbook_files` tool accepts no path or folder ID. Starting from the configured `logbook` folder, it discovers only direct child folders named `YYYY` and lists only their direct Google Spreadsheet children. It uses the read-only Drive metadata scope.

## How to run

```bash
nvm use
npm i
npm run build
npm run dev # runs the MCP server
npm run inspector # run in a separate shell
```
