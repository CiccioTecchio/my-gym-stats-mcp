# My Gym Stats MCP

I love working out, and I have kept a logbook since I started training. It tracks my progress, including the weight lifted and the number of sets and repetitions performed.

The logbook is stored in Google Drive as a collection of Google Sheets. Each spreadsheet covers one month, with a separate tab for every training session.

This project makes that data accessible to an LLM client—ChatGPT, in my case. The client sends requests to a Node.js MCP server, which reads the logbook through the Google Sheets API and returns the requested information.

A concrete example of the resulting output is shown in [this image](img/results.png).

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

1. Enable both the Google Drive API and Google Sheets API in your Google Cloud project.
2. Configure [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials). If you use a service account, share only the `logbook` folder with its email address.
3. Copy `.env.example` to `.env` and set:
   - `GOOGLE_APPLICATION_CREDENTIALS` to the absolute path of the credentials file.
   - `GOOGLE_DRIVE_LOGBOOK_FOLDER_ID` to the ID from the `logbook` folder URL.

All tools are read-only. Starting from the configured `logbook` folder, the server discovers only direct child folders named `YYYY` and only their direct Google Spreadsheet children. Callers cannot provide paths, file IDs, URLs, or cell ranges.

## Tools

| Tool | Purpose | Input |
| --- | --- | --- |
| `list_logbook_files` | List the available monthly spreadsheets without reading their cells | None |
| `read_logbook_month` | Read every worksheet for one month | `year`, `month` |
| `read_logbook_year` | Read every monthly spreadsheet for one year | `year` |
| `read_entire_logbook` | Read all valid monthly spreadsheets across every year | None |

The reading tools use the `spreadsheets.readonly` scope. A single response is limited to 250,000 populated cells and 4,000,000 serialized characters.

## How to run

```bash
nvm use
npm i
npm run build
npm run dev # runs the MCP server
npm run inspector # run in a separate shell
```

## How to use with ChatGPT

This server can be connected to ChatGPT through an OpenAI [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), without exposing the local MCP server to the public internet.

### 1. Prepare the project

Complete the [Configuration](#configuration) steps, then install the dependencies and build the server:

```bash
nvm use
npm install
npm run build
```

### 2. Create an OpenAI tunnel

1. Open the [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
2. Create a tunnel and associate it with the ChatGPT workspace that will use it.
3. Copy its `tunnel_id`.
4. Create a runtime API key with **Tunnels Read + Use** permission. Creating or editing the tunnel also requires **Tunnels Read + Manage**.
5. Download and install the latest `tunnel-client` release linked from the tunnel settings page.

Keep the API key private. Load it into the shell used to run the tunnel client:

```bash
export CONTROL_PLANE_API_KEY="sk-..."
```

### 3. Configure the tunnel client

Replace the example tunnel ID and both project paths with your own absolute values:

```bash
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile my-gym-stats \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --mcp-command "node --env-file=/absolute/path/to/my-gym-stats-mcp/.env /absolute/path/to/my-gym-stats-mcp/dist/index.js"
```

Validate the profile before starting it:

```bash
tunnel-client doctor --profile my-gym-stats --explain
```

### 4. Start the tunnel

```bash
tunnel-client run --profile my-gym-stats
```

Keep this process running while using the plugin. The tunnel client starts the MCP server itself, so `npm run dev` or `npm start` does not need to run separately.

### 5. Add the MCP server to ChatGPT

1. Open [ChatGPT Plugins](https://chatgpt.com/#settings/Connectors).
2. Select the plus button, then **Add custom MCP server**.
3. Enter a name such as `My Gym Stats`.
4. Under **Connection**, select **Tunnel**, then select the tunnel or paste its `tunnel_id`.
5. Select **No authentication**. Authentication to Google is handled locally by the server credentials configured in `.env`.
6. Review the security warning, select **I understand and want to continue**, and create the plugin.
7. Install the plugin in your personal plugins or the intended workspace.

In a conversation, type `@My Gym Stats` and ask ChatGPT to use one of the available tools. For example:

> Use My Gym Stats to read March 2025 and summarize my training sessions.

If ChatGPT cannot discover or call the tools, confirm that `tunnel-client run` is still active and rerun:

```bash
tunnel-client doctor --profile my-gym-stats --explain
```

After changing tool names, descriptions, or schemas, rebuild the project, restart the tunnel client, and refresh the plugin from its ChatGPT settings. See the official OpenAI guide for [custom MCP servers](https://developers.openai.com/api/docs/guides/custom-mcp-server) for the current ChatGPT workflow.

> [!IMPORTANT]
> The server uses the Google credentials configured in `.env`. Everyone authorized to use this plugin accesses the same logbook, so associate the tunnel and plugin only with the intended account or workspace.
