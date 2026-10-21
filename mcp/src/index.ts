#!/usr/bin/env node
// MCP server that lets Claude use the Get into zone browser extension.
// Talks to the extension over a local WebSocket (see bridge.ts).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

import { Bridge } from "./bridge.js"

const PORT = Number(process.env.GET_INTO_ZONE_PORT) || 17892
const bridge = new Bridge(PORT, process.env.GET_INTO_ZONE_EXTENSION_ID || undefined)

const server = new McpServer(
  { name: "get-into-zone", version: "0.1.0" },
  {
    instructions:
      "Tools for the Get into zone browser extension running in the user's Chrome: bulk-download Pinterest pins, " +
      "download YouTube videos, save media to Mediamake, toggle on-page saver overlays, upload Suno tracks and automate Midjourney. " +
      "Tools act on the user's real browser tabs; most take an optional tabId (see list_tabs) and default to the active tab. " +
      "Downloads land in the browser's Downloads folder. Call get_status first if a tool says the extension isn't connected."
  }
)

const tabId = z.number().int().optional().describe("Browser tab id from list_tabs. Defaults to the active tab.")
const tags = z.array(z.string()).optional().describe("Mediamake tags. Defaults to the tags in the extension's Settings.")

type Shape = Record<string, z.ZodType>

function tool(
  name: string,
  description: string,
  inputSchema: Shape,
  method: string,
  options: { readOnly?: boolean; destructive?: boolean; timeoutMs?: number } = {}
) {
  server.registerTool(
    name,
    {
      description,
      inputSchema,
      annotations: {
        readOnlyHint: options.readOnly ?? false,
        destructiveHint: options.destructive ?? false,
        openWorldHint: true
      }
    },
    async (params: Record<string, unknown>) => {
      try {
        const result = await bridge.call(method, params, options.timeoutMs)
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result ?? { ok: true }, null, 2) }]
        }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }]
        }
      }
    }
  )
}

// --- Status, tabs and settings ---

tool(
  "get_status",
  "Shows whether the extension is connected to this server, and its version.",
  {},
  "bridge.status",
  { readOnly: true }
)
tool(
  "list_tabs",
  "Lists the open browser tabs (id, url, title, active) so other tools can target one.",
  { urlPattern: z.string().optional().describe('Chrome match pattern, e.g. "*://*.pinterest.com/*"') },
  "tabs.list",
  { readOnly: true }
)
tool(
  "open_tab",
  "Opens a URL in a new browser tab and waits for it to load. Returns the tab, including its id.",
  {
    url: z.string().url(),
    active: z.boolean().optional().describe("Focus the new tab (default true)."),
    waitForLoad: z.boolean().optional().describe("Wait until the page has loaded (default true).")
  },
  "tabs.open"
)
tool(
  "get_settings",
  "Reads the extension's Mediamake settings: API endpoint, whether an API key is set, default tags and default project.",
  {},
  "settings.get",
  { readOnly: true }
)
tool(
  "update_settings",
  "Changes the extension's Mediamake settings. Only the fields you pass are changed.",
  {
    apiEndpoint: z.string().optional().describe("Mediamake URL"),
    apiKey: z.string().optional().describe("Mediamake API key"),
    tags: z.string().optional().describe("Comma-separated default tags"),
    selectedProjectId: z.string().optional().describe("Default Mediamake project id (see list_projects)")
  },
  "settings.update"
)
tool("list_projects", "Lists the Mediamake projects the API key can see.", {}, "projects.list", {
  readOnly: true
})

// --- Mediamake ---

tool(
  "save_media_to_mediamake",
  "Saves an image or video URL to Mediamake (same as the on-page Save button), optionally with AI analysis.",
  {
    sourceUrl: z.string().url().describe("Direct URL of the image or video file"),
    contentType: z.enum(["image", "video"]).optional(),
    mimeType: z.string().optional().describe('e.g. "image/jpeg", "video/mp4"'),
    fileName: z.string().optional(),
    pageUrl: z.string().optional().describe("Page the media was found on"),
    alt: z.string().optional(),
    tags,
    projectId: z.string().optional().describe("Used only when no default project is set in Settings"),
    analyzeImage: z.boolean().optional(),
    generateDescription: z.boolean().optional(),
    generateKeywords: z.boolean().optional()
  },
  "mediamake.save"
)

// --- Pinterest ---

tool(
  "pinterest_bulk_start",
  "Starts bulk-downloading every pin image (and video) shown in a Pinterest tab. The session keeps saving new pins as the tab " +
    "is scrolled or navigated (pages already visited are skipped) until pinterest_bulk_stop. Scroll or navigate the tab to collect more.",
  {
    tabId: tabId.describe("Pinterest tab id. Defaults to the active tab if it's Pinterest, else the first Pinterest tab."),
    destination: z.enum(["browser", "mediamake"]).default("browser").describe("Browser downloads folder or Mediamake upload"),
    folder: z.string().optional().describe('Subfolder of Downloads for images (default "pinterest-YYYY-MM-DD")'),
    includeVideos: z.boolean().optional().describe("Also download video pins (default true)"),
    videoFolder: z.string().optional().describe('Subfolder for videos (default "<folder>/videos")'),
    tags,
    perPageLimit: z.number().int().min(0).optional().describe("Max images, and separately videos, per page; 0 = no limit")
  },
  "pinterest.bulkStart"
)
tool("pinterest_bulk_stop", "Stops the bulk download session in a Pinterest tab.", { tabId }, "pinterest.bulkStop")
tool(
  "pinterest_bulk_status",
  "Shows bulk download sessions: saved images and videos, queued, failed, pages visited.",
  { tabId: z.number().int().optional().describe("Only this tab's session") },
  "pinterest.bulkStatus",
  { readOnly: true }
)
tool(
  "pinterest_analyze_image",
  "Runs Mediamake AI analysis on an image (description, keywords, art style) without saving it.",
  {
    imageUrl: z.string().url(),
    pageUrl: z.string().optional(),
    imageAlt: z.string().optional(),
    prompt: z.string().optional().describe("Extra instructions for the analysis"),
    tags
  },
  "pinterest.analyzeImage",
  { timeoutMs: 180_000 }
)
tool(
  "pinterest_save_analysis",
  "Stores an image analysis in Mediamake (shows up in the extension's Pinterest tab).",
  {
    imageUrl: z.string().url(),
    pageUrl: z.string(),
    imageAlt: z.string().optional(),
    description: z.string(),
    keywords: z.array(z.string()).optional(),
    artStyle: z.array(z.string()).optional(),
    audienceKeywords: z.array(z.string()).optional()
  },
  "pinterest.saveAnalysis"
)
tool(
  "pinterest_list_analyses",
  "Lists saved Pinterest image analyses from Mediamake.",
  { limit: z.number().int().positive().optional(), offset: z.number().int().min(0).optional() },
  "pinterest.listAnalyses",
  { readOnly: true }
)

// --- YouTube ---

const youtubeTarget = {
  url: z.string().optional().describe("YouTube video URL (watch, shorts, youtu.be, live replay)"),
  tabId: z.number().int().optional().describe("A tab playing the video, instead of url")
}

tool(
  "youtube_get_video",
  "Reads a YouTube video's title, channel, length and the download options for each mode " +
    '("both" = MP4 with sound, "video" = picture only, "audio" = sound only), best first.',
  youtubeTarget,
  "youtube.getVideo",
  { readOnly: true, timeoutMs: 90_000 }
)
tool(
  "youtube_download",
  "Downloads a YouTube video to the browser's Downloads folder. Runs in the background; check youtube_list_downloads for progress.",
  {
    ...youtubeTarget,
    mode: z.enum(["both", "video", "audio"]).optional().describe('Default "both" (MP4 with sound)'),
    optionId: z.string().optional().describe("Exact option id from youtube_get_video. Default: best quality"),
    maxHeight: z.number().int().positive().optional().describe("Best option at or below this height, e.g. 1080")
  },
  "youtube.download",
  { timeoutMs: 90_000 }
)
tool(
  "youtube_list_downloads",
  "Lists YouTube downloads with status (downloading, merging, saving, done, error, cancelled) and bytes received.",
  {},
  "youtube.listDownloads",
  { readOnly: true }
)
tool("youtube_cancel_download", "Cancels a running YouTube download.", { jobId: z.string() }, "youtube.cancelDownload", {
  destructive: true
})
tool("youtube_clear_finished", "Clears finished downloads from the list (files stay on disk).", {}, "youtube.clearFinished")

// --- Saver overlays ---

const saverTarget = {
  tabId,
  url: z.string().optional().describe("Page URL to check instead of a tab (window scope then unavailable)")
}

tool(
  "saver_get",
  "Shows which on-page overlays (Save button, AI analyse, YouTube buttons) are on for a tab, and the rules involved.",
  saverTarget,
  "saver.get",
  { readOnly: true }
)
tool(
  "saver_set",
  "Turns an on-page overlay on or off. The narrowest rule wins: page > site > window > everywhere.",
  {
    ...saverTarget,
    feature: z.enum(["all", "save", "ai", "youtube"]).describe('"all" is the master switch for every overlay'),
    scope: z.enum(["page", "site", "window", "all"]).describe('"all" means everywhere'),
    enabled: z.boolean()
  },
  "saver.set"
)
tool(
  "saver_remove_rule",
  "Removes one overlay rule (as listed by saver_get).",
  {
    feature: z.enum(["all", "save", "ai", "youtube"]),
    scope: z.enum(["page", "site", "window", "all"]),
    key: z.string()
  },
  "saver.removeRule",
  { destructive: true }
)
tool("saver_reset", "Removes every overlay rule, so all overlays are on everywhere.", {}, "saver.reset", {
  destructive: true
})

// --- Suno ---

tool(
  "suno_upload_track",
  "Sends a Suno track to Mediamake for transcription. Without audioUrl, uses the track open in the suno.com tab.",
  {
    audioUrl: z.string().optional(),
    title: z.string().optional(),
    lyrics: z.string().optional(),
    tags,
    language: z.string().optional().describe('Default "en"')
  },
  "suno.uploadTrack"
)

// --- Midjourney ---

tool(
  "midjourney_submit_prompts",
  "Types prompts into Midjourney (midjourney.com/imagine) one at a time, waiting while Midjourney's queue is full.",
  {
    prompts: z
      .array(z.union([z.string(), z.object({ prompt: z.string(), tag: z.string().optional() })]))
      .min(1)
      .describe("Prompts; an object's tag is the Midjourney folder for that prompt"),
    folderTag: z.string().optional().describe("Midjourney folder for prompts without their own tag"),
    promptSuffix: z.string().optional().describe('Appended to every prompt, e.g. "--ar 16:9 --v 7"'),
    delayMs: z.number().int().positive().optional().describe("Wait between prompts (default 15000)"),
    maxQueueSize: z.number().int().positive().optional().describe("Wait while Midjourney has this many queued jobs (default 8)"),
    useLastImage: z.boolean().optional()
  },
  "midjourney.submitPrompts"
)
tool(
  "midjourney_scrape",
  "Scrapes the generated images and prompts from the open Midjourney tab.",
  {},
  "midjourney.scrape",
  { readOnly: true, timeoutMs: 180_000 }
)
tool("midjourney_queue_size", "Reads how many jobs Midjourney has queued.", {}, "midjourney.queueSize", {
  readOnly: true
})
const queueFilter = {
  limit: z.number().int().positive().optional().describe("Default 10"),
  projectId: z.string().optional().describe("Default: the project in Settings"),
  allProjects: z.boolean().optional()
}
tool(
  "midjourney_list_queue",
  "Lists pending Midjourney requests in the Mediamake queue, highest priority first.",
  queueFilter,
  "midjourney.listQueue",
  { readOnly: true }
)
tool(
  "midjourney_run_queue",
  "Loads pending requests from the Mediamake queue and submits them to Midjourney in order; their status updates in Mediamake.",
  {
    ...queueFilter,
    folderTag: z.string().optional().describe("Folder for requests without one"),
    overwriteQueueFolder: z.boolean().optional().describe("Use folderTag even for requests that have a folder"),
    delayMs: z.number().int().positive().optional(),
    maxQueueSize: z.number().int().positive().optional(),
    useLastImage: z.boolean().optional()
  },
  "midjourney.runQueue"
)
tool(
  "midjourney_load_prompts",
  "Loads a saved prompt set from Mediamake (to pass to midjourney_submit_prompts).",
  { recordId: z.string().optional().describe('Prompt record id; default "random"') },
  "midjourney.loadPrompts",
  { readOnly: true }
)

await server.connect(new StdioServerTransport())
// Start listening right away so the extension can connect before the first call.
bridge.ensure().catch((error) => console.error("[bridge]", error.message))
