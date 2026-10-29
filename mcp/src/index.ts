#!/usr/bin/env node
// MCP server that lets Claude use the Browse Hack browser extension.
// Talks to the extension over a local WebSocket (see bridge.ts).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

import { Bridge } from "./bridge.js"
import { fillDistrokidReleases } from "./distrokid.js"
import { batchStatus, pauseBatch, startBatch } from "./midjourneyBatch.js"
import { toSource } from "./sources.js"

// GET_INTO_ZONE_* are the names from before the rename to Browse Hack.
const env = (name: string) => process.env[`BROWSE_HACK_${name}`] || process.env[`GET_INTO_ZONE_${name}`]
const PORT = Number(env("PORT")) || 17892
const bridge = new Bridge(PORT, env("EXTENSION_ID") || undefined)

const server = new McpServer(
  { name: "browse-hack", version: "0.1.0" },
  {
    instructions:
      "Tools for the Browse Hack browser extension running in the user's Chrome: bulk-download Pinterest pins, " +
      "download YouTube videos and Instagram posts, reels and stories, save media to Mediamake, toggle on-page saver overlays, upload Suno tracks, automate Midjourney, " +
      "and fill DistroKid's new-release form from local folders (one tab per release, never clicking Continue). " +
      "Every tool needs the extension signed in to Mediamake; if a tool says it isn't, call sign_in_to_mediamake and tell the " +
      "user to sign in and click Allow in the window that opens. For more than a few Midjourney prompts, use midjourney_batch_start. " +
      "midjourney_repaint opens a brush tab so the user can erase part of an image by hand; tell them to paint and click Repaint, then call midjourney_repaint_status. " +
      "Tools act on the user's real browser tabs; most take an optional tabId (see list_tabs) and default to the active tab. " +
      "Downloads land in the browser's Downloads folder. Call get_status first if a tool says the extension isn't connected. " +
      "The extension may be installed in several Chrome profiles (accounts). When two or more are connected, ask the user which " +
      "profile to use for this session before doing anything else (list_profiles shows them), then call use_profile; every tool " +
      "then runs in that profile only. Never pick a profile on the user's behalf. Name each profile to the user by its Google " +
      "account email (plus its name, if it has one), never by number alone: users don't know their profile numbers."
  }
)

const tabId = z.number().int().optional().describe("Browser tab id from list_tabs. Defaults to the active tab.")
const tags = z.array(z.string()).optional().describe("Mediamake tags. Defaults to the tags in the extension's Settings.")

type Shape = Record<string, z.ZodType>
type Params = Record<string, any>

function tool(
  name: string,
  description: string,
  inputSchema: Shape,
  method: string,
  options: {
    readOnly?: boolean
    destructive?: boolean
    timeoutMs?: number | ((params: Params) => number)
    // Rewrites the tool's arguments into the extension method's params.
    prepare?: (params: Params) => Promise<Params>
  } = {}
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
    async (params: Params) => {
      try {
        const timeoutMs =
          typeof options.timeoutMs === "function" ? options.timeoutMs(params) : options.timeoutMs
        const result = await bridge.call(
          method,
          options.prepare ? await options.prepare(params) : params,
          timeoutMs
        )
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

// Tools that run here (reading local files, batches) instead of in the extension.
function localTool(name: string, description: string, inputSchema: Shape, run: (params: Params) => Promise<unknown>, readOnly = false) {
  server.registerTool(
    name,
    {
      description,
      inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: true }
    },
    async (params: Params) => {
      try {
        const result = await run(params)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
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
  "Shows whether the extension is connected, the Chrome profiles it's connected in (with each one's Mediamake sign-in), " +
    "and which one this session uses.",
  {},
  "bridge.status",
  { readOnly: true }
)
tool(
  "list_profiles",
  "Lists the Chrome profiles the extension is connected in: Google account email, name, open tab count and active tab. " +
    "Show these to the user by email when asking which profile to use, never by number alone.",
  {},
  "bridge.profiles",
  { readOnly: true }
)
tool(
  "use_profile",
  "Makes every tool in this session run in one Chrome profile. Call it with the profile the user chose; " +
    "needed whenever the extension is connected in two or more profiles.",
  {
    profile: z
      .union([z.string(), z.number().int()])
      .describe("The profile's email (preferred), name, id or number, as shown by list_profiles")
  },
  "bridge.useProfile"
)
tool(
  "list_tabs",
  "Lists the open browser tabs (id, url, title, active) of this session's Chrome profile so other tools can target one.",
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
  "sign_in_to_mediamake",
  "Opens Mediamake's sign-in window in Chrome and waits (up to 10 minutes) for the user to sign in and click Allow. " +
    "Every other tool needs the extension signed in. Tell the user to look for the window before calling it. " +
    "Returns the account it signed in as. Already signed in: returns that, unless force is true (to switch accounts).",
  { force: z.boolean().optional().describe("Sign in again even when already signed in") },
  "auth.signIn",
  { timeoutMs: 10 * 60_000 }
)
tool(
  "get_settings",
  "Reads the extension's settings: the Mediamake URL and account it's signed in to (and whether by sign-in or API key), default tags and default project.",
  {},
  "settings.get",
  { readOnly: true }
)
tool(
  "update_settings",
  "Changes the extension's default tags and default Mediamake project. Only the fields you pass are changed. " +
    "Signing in, API keys and the Mediamake URL are changed by the user in the popup.",
  {
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

// --- Instagram ---

const instagramTarget = {
  url: z.string().optional().describe("Instagram post, reel or story URL (story links need the item id; highlights aren't supported)"),
  tabId: z.number().int().optional().describe("A tab showing the post, instead of url. Default: the active tab")
}

tool(
  "instagram_get_post",
  "Reads an Instagram post, reel or story: author, caption and each photo or video in it (numbered from 1 for carousels). " +
    "Uses the user's logged-in Instagram session from any instagram.com tab; one opens in the background if none is open.",
  instagramTarget,
  "instagram.getPost",
  { readOnly: true, timeoutMs: 60_000 }
)
tool(
  "instagram_download",
  "Downloads the photos and videos of an Instagram post, reel or story to the browser's Downloads folder at full size, " +
    "and returns each saved file's path. Waits until the files are saved.",
  {
    ...instagramTarget,
    items: z
      .array(z.number().int().positive())
      .optional()
      .describe("Item numbers from instagram_get_post to save, e.g. [2]. Default: every item")
  },
  "instagram.download",
  { timeoutMs: 300_000 }
)

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

// --- Midjourney images (API jobs) ---

const image = (what: string) =>
  z
    .string()
    .describe(
      `${what}: an image URL, an absolute local file path (PNG, JPEG, WebP, GIF), or mj:<jobId>#<index> for a Midjourney result`
    )
const jobParams = {
  mode: z.enum(["relaxed", "fast", "turbo"]).optional().describe('GPU speed; default "relaxed"'),
  private: z.boolean().optional().describe("Stealth mode (Pro and Mega plans)"),
  extraFlags: z
    .string()
    .optional()
    .describe('Other Midjourney parameters, e.g. "--raw --stylize 250 --v 8.2"'),
  wait: z.boolean().optional().describe("Wait for the images (default true). False returns the job id right away"),
  timeoutMs: z
    .number()
    .int()
    .min(0)
    .max(1_800_000)
    .optional()
    .describe("How long to wait for the images (default 240000). On timeout, poll midjourney_job_status")
}
const WAIT_MS = 240_000
const jobTimeout = (p: Params) => (p.wait === false ? 0 : (p.timeoutMs ?? WAIT_MS)) + 120_000
const withWait = (p: Params) => ({ ...p, timeoutMs: p.timeoutMs ?? WAIT_MS })

tool(
  "midjourney_outcrop",
  "Outcrops (outpaints) an image with Midjourney: places it in a larger frame of the given aspect ratio and fills the " +
    "empty area to match the prompt, like the Editor's Move + aspect ratio + Submit edit. Returns 4 images.",
  {
    image: image("The image to extend"),
    prompt: z.string().min(1).describe("What the whole image should look like, e.g. \"anime digital art\""),
    aspectRatio: z.string().describe('New frame, e.g. "16:9", "9:16", "1:1", "3:2" (up to 4:1)'),
    anchor: z
      .enum(["center", "left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"])
      .optional()
      .describe("Where the original sits in the new frame (default center); new content fills the other side"),
    scale: z
      .number()
      .min(0.05)
      .max(1)
      .optional()
      .describe("Shrinks the original inside the frame (default 1 = as large as fits). 0.6 adds new content on every side (zoom out)"),
    offsetX: z.number().int().optional().describe("Nudge in frame pixels after anchoring"),
    offsetY: z.number().int().optional(),
    ...jobParams
  },
  "midjourney.outcrop",
  {
    timeoutMs: jobTimeout,
    prepare: async ({ image: source, offsetX, offsetY, ...p }) => ({
      ...withWait(p),
      source: await toSource(source),
      offset: { x: offsetX ?? 0, y: offsetY ?? 0 }
    })
  }
)
tool(
  "midjourney_repaint",
  "Opens a brush on the image in Chrome so the user can erase the parts Midjourney should repaint. Same Editor job as " +
    "midjourney_outcrop (transparent pixels get painted), but the region has to be brushed by hand. Returns immediately " +
    "with sessionId. Tell the user to brush and click Repaint, then call midjourney_repaint_status. You cannot paint the mask.",
  {
    image: image("The image to edit"),
    prompt: z
      .string()
      .min(1)
      .describe("What the finished image should show, including what replaces the brushed area"),
    mode: jobParams.mode,
    private: jobParams.private,
    extraFlags: jobParams.extraFlags
  },
  "midjourney.repaint",
  {
    prepare: async ({ image: source, ...p }) => ({
      ...p,
      source: await toSource(source)
    })
  }
)
tool(
  "midjourney_repaint_status",
  "After midjourney_repaint, waits for the user to click Repaint and then for Midjourney's images. " +
    "Call it only after you have told the user to brush the parts to change.",
  {
    sessionId: z.string().describe("sessionId from midjourney_repaint"),
    wait: z
      .boolean()
      .optional()
      .describe("Wait for the brush and the images (default true). False returns the current state"),
    paintTimeoutMs: z
      .number()
      .int()
      .min(0)
      .max(1_800_000)
      .optional()
      .describe("How long to wait for the user to click Repaint (default 600000). Then timeoutMs applies to the job"),
    timeoutMs: jobParams.timeoutMs
  },
  "midjourney.repaintStatus",
  {
    timeoutMs: (p) =>
      p.wait === false ? 30_000 : (p.paintTimeoutMs ?? 600_000) + (p.timeoutMs ?? WAIT_MS) + 120_000,
    prepare: async (p) => ({
      ...p,
      paintTimeoutMs: p.paintTimeoutMs ?? 600_000,
      timeoutMs: p.timeoutMs ?? WAIT_MS
    })
  }
)
tool(
  "midjourney_generate",
  "Creates images on Midjourney's Create page, optionally from your images: imagePrompts guide content and composition, " +
    "styleReferences copy a look (--sref), omniReferences put a subject or character in the image (--oref), and editImage " +
    "redraws that image to the prompt, e.g. in a different style (--edit). Returns 4 images.",
  {
    prompt: z.string().min(1).describe("Text prompt. Parameters can go here or in extraFlags"),
    imagePrompts: z.array(image("Image prompt")).max(5).optional(),
    styleReferences: z
      .array(image("Style reference").or(z.string()))
      .max(5)
      .optional()
      .describe("Images (or numeric sref codes) whose style to use"),
    omniReferences: z.array(image("Omni reference")).max(1).optional(),
    editImage: image("Image to restyle or edit").optional(),
    ...jobParams
  },
  "midjourney.generate",
  {
    timeoutMs: jobTimeout,
    prepare: async ({ imagePrompts, styleReferences, omniReferences, editImage, ...p }) => ({
      ...withWait(p),
      imagePrompts: await Promise.all((imagePrompts ?? []).map((v: string) => toSource(v))),
      styleReferences: await Promise.all(
        (styleReferences ?? []).map((v: string) => toSource(v, { allowStyleCode: true }))
      ),
      omniReferences: await Promise.all((omniReferences ?? []).map((v: string) => toSource(v))),
      editImage: editImage ? await toSource(editImage) : undefined
    })
  }
)
// --- Midjourney result buttons (vary, upscale, pan, zoom) ---

const resultImage = {
  jobId: z
    .string()
    .describe(
      "The finished job: its id, mj:<jobId>#<index>, or a cdn.midjourney.com/<jobId>/0_<index>.png URL. Must be the user's own job"
    ),
  index: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe("Which image of the grid (0-3). Default: the index in jobId, else 0")
}
const actionParams = {
  mode: jobParams.mode,
  private: jobParams.private,
  wait: jobParams.wait,
  timeoutMs: jobParams.timeoutMs
}
const actionPrompt = z
  .string()
  .optional()
  .describe(
    "Replaces the parent's prompt, like Remix. Include any parameters to keep. Default: the parent's prompt and parameters"
  )
const action = (prepare?: (p: Params) => Params) => ({
  timeoutMs: jobTimeout,
  prepare: async (p: Params) => withWait(prepare ? prepare(p) : p)
})

tool(
  "midjourney_vary",
  "Makes four new variations of one image from a finished Midjourney job, like its Vary (Subtle) or Vary (Strong) button.",
  {
    ...resultImage,
    strength: z.enum(["subtle", "strong"]).optional().describe('Default "subtle": close to the original. "strong" changes more'),
    ...actionParams
  },
  "midjourney.vary",
  action(({ strength, ...p }) => ({ ...p, strong: strength === "strong" }))
)
tool(
  "midjourney_upscale",
  "Upscales one image from a finished Midjourney job to twice its size, like its Upscale (Subtle) or Upscale (Creative) " +
    "button. Returns 1 image. Works for --v 5 to 8.2 and niji 5 to 7 (not --v 8, --hd or --draft images).",
  {
    ...resultImage,
    kind: z
      .enum(["subtle", "creative"])
      .optional()
      .describe('Default "subtle" keeps the image as it is. "creative" adds detail. On --v 5 images, subtle is 2x and creative 4x'),
    ...actionParams
  },
  "midjourney.upscale",
  action()
)
tool(
  "midjourney_pan",
  "Pans one image from a finished Midjourney job: extends it by half its width or height in one direction and fills " +
    "the new area, like its Pan buttons. Returns 4 images. Works for --v 5 to 8.2 and niji 5 to 7 (not --v 8).",
  {
    ...resultImage,
    direction: z.enum(["left", "right", "up", "down"]).describe("Side to add new content to"),
    prompt: actionPrompt,
    ...actionParams
  },
  "midjourney.pan",
  action()
)
tool(
  "midjourney_zoom_out",
  "Zooms out one image from a finished Midjourney job: shrinks it inside a frame of the same shape and fills around " +
    "it, like its Zoom Out buttons. Returns 4 images. Works for --v 5 to 8.2 and niji 5 to 7 (not --v 8). For a new " +
    "aspect ratio or an image that isn't a Midjourney result, use midjourney_outcrop.",
  {
    ...resultImage,
    zoom: z.number().min(1.1).max(2).optional().describe("How far to zoom out: 1.5 (default) or 2, or anything between"),
    prompt: actionPrompt,
    ...actionParams
  },
  "midjourney.zoomOut",
  action()
)
tool(
  "midjourney_job_status",
  "Checks a Midjourney job started by any midjourney_ image tool (outcrop, repaint, generate, vary, upscale, pan, zoom_out); with wait, waits until its images are ready.",
  {
    jobId: z.string(),
    wait: z.boolean().optional(),
    timeoutMs: jobParams.timeoutMs
  },
  "midjourney.jobStatus",
  { readOnly: true, timeoutMs: jobTimeout, prepare: async (p) => (p.wait ? withWait(p) : p) }
)
localTool(
  "distrokid_fill_releases",
  "Fills DistroKid's upload form at https://distrokid.com/new/ from local release folders, one browser tab per folder. " +
    "Each folder needs info.json, at least one .wav/.m4a/.mp3, and a square JPG, PNG, or GIF cover. " +
    "A parent folder works when each child folder has its own info.json. " +
    "Does not click Continue or submit. The user reviews each tab and clicks Continue.",
  {
    folders: z
      .array(z.string())
      .min(1)
      .describe(
        "Absolute paths. Each path is a release folder, or a parent whose immediate child folders each contain info.json."
      ),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(6)
      .optional()
      .describe("How many DistroKid tabs to fill at the same time. Default 3.")
  },
  ({ folders, concurrency }) => fillDistrokidReleases(bridge, folders, concurrency ?? 3)
)

tool(
  "midjourney_download_images",
  "Saves a Midjourney job's images to the browser's Downloads folder as <folder>/<jobId>_<index>.png, or " +
    "<folder>/<name>-<index>.png with a name (replacing an older file of that name). Returns each file's path.",
  {
    jobId: z.string(),
    indexes: z.array(z.number().int().min(0).max(3)).optional().describe("Which images (default all of them: 4, or 1 for an upscale)"),
    folder: z.string().optional().describe('Subfolder of Downloads (default "midjourney")'),
    name: z.string().optional().describe('File name before "-<index>.png", e.g. "pin-001-a"')
  },
  "midjourney.downloadImages",
  { timeoutMs: 180_000 }
)

// --- Midjourney batches ---

const batchFolder = z
  .string()
  .describe("Absolute path of the batch folder: images, state.json and run.log go here. It identifies the batch")
const batchJob = z.object({
  name: z.string().describe('Unique; images are saved as <name>-<index>.png, e.g. "pin-001-a"'),
  prompt: z.string().min(1),
  imagePrompts: z.array(z.string()).max(5).optional().describe("Image URLs, absolute file paths or mj:<jobId>#<index>"),
  styleReferences: z.array(z.string()).max(5).optional().describe("Images or sref codes (--sref)"),
  omniReferences: z.array(z.string()).max(1).optional().describe("A subject image (--oref)"),
  extraFlags: z.string().optional().describe('Parameters for this job only, e.g. "--ar 2:3"')
})

localTool(
  "midjourney_batch_start",
  "Runs many Midjourney prompts in the background with one call: keeps a few jobs in Midjourney at a time (relaxed " +
    "mode by default), waits for each, and saves its 4 images to the folder as <name>-<index>.png. Returns right away. " +
    "Survives Chrome or the extension going away (it waits and carries on) and keeps the Mac awake while it runs. " +
    "Starting it again on the same folder resumes it (jobs already done are skipped, jobs in Midjourney are picked up) " +
    "and adds any new jobs. Use jobsFile for long lists.",
  {
    folder: batchFolder,
    jobs: z.array(batchJob).optional(),
    jobsFile: z
      .string()
      .optional()
      .describe("JSON file with the jobs: an array or { jobs: [...] }. Relative image paths are relative to it"),
    concurrency: z.number().int().min(1).max(12).optional().describe("Jobs in Midjourney at once (default 6)"),
    mode: z.enum(["relaxed", "fast", "turbo"]).optional().describe('GPU speed; default "relaxed"'),
    private: z.boolean().optional().describe("Stealth mode (Pro and Mega plans)"),
    extraFlags: z.string().optional().describe('Parameters for every job, e.g. "--v 7 --stylize 250"'),
    retryFailed: z.boolean().optional().describe("Send failed jobs again")
  },
  (params) => startBatch(bridge, params as any)
)
localTool(
  "midjourney_batch_status",
  "Shows a batch's progress: jobs to do, in Midjourney, saved and failed, what it's waiting for, and recent errors. " +
    "waitMs waits until the batch finishes (or that long) first, instead of checking again and again.",
  {
    folder: batchFolder,
    waitMs: z.number().int().min(0).max(600_000).optional().describe("Wait up to this long for the batch to finish"),
    details: z.boolean().optional().describe("Include every job")
  },
  (params) => batchStatus(bridge, params as any),
  true
)
localTool(
  "midjourney_batch_pause",
  "Pauses a batch: no new jobs are sent, the ones in Midjourney finish and are saved, then it stops. With now, it " +
    "stops at once (jobs in Midjourney are saved when it resumes). Resume with midjourney_batch_start on the same folder.",
  { folder: batchFolder, now: z.boolean().optional() },
  async (params) => pauseBatch(bridge, params as any)
)

await server.connect(new StdioServerTransport())
// Start listening right away so the extension can connect before the first call.
bridge.ensure().catch((error) => console.error("[bridge]", error.message))
