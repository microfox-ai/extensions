export const normalizeTags = (input: unknown): string[] => {
  if (Array.isArray(input)) {
    const clean = input
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0)
    return clean.length > 0 ? Array.from(new Set(clean)) : ["pinterest"]
  }
  if (typeof input === "string") {
    const clean = input
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    return clean.length > 0 ? Array.from(new Set(clean)) : ["pinterest"]
  }
  return ["pinterest"]
}

export interface SparkboardIndexRequest {
  contentType?: "image" | "video"
  sourceUrl?: string
  tags?: unknown
  projectId?: string
  clientId?: string
  contentMimeType?: string
  contentSubType?: string
  contentSource?: string
  contentSourceUrl?: string
  fileName?: string
  fileSize?: number
  filePath?: string
  uploadFolder?: string
  metadata?: Record<string, unknown>
  analyzeImage?: boolean
  generateDescription?: boolean
  generateKeywords?: boolean
}

export interface MediamakeResult {
  success: boolean
  message?: string
  data?: unknown
}

async function loadConfig() {
  const result = await chrome.storage.local.get([
    "apiEndpoint",
    "apiKey",
    "selectedProjectId"
  ])
  const baseUrl =
    typeof result.apiEndpoint === "string"
      ? result.apiEndpoint.replace(/\/+$/, "")
      : ""
  const headers: Record<string, string> = {}
  if (result.apiKey && typeof result.apiKey === "string") {
    headers["Authorization"] = `Bearer ${result.apiKey}`
  }
  return { result, baseUrl, headers }
}

// A JSON request to the Mediamake API, authorized with the API key from Settings.
export async function mediamakeFetch(path: string, init: RequestInit = {}) {
  const { baseUrl, headers } = await loadConfig()
  if (!baseUrl) throw new Error("Missing API Endpoint in Settings.")
  const resp = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...headers
    }
  })
  const data = await resp.json().catch(() => null)
  if (!resp.ok) {
    throw new Error(data?.error || `Mediamake request failed: ${resp.status}`)
  }
  return data
}

// A presigned S3 PUT for uploading a file the extension built itself.
export async function getUploadUrl(
  filename: string,
  contentType: string
): Promise<{ uploadUrl: string; publicUrl: string }> {
  const { baseUrl, headers } = await loadConfig()
  if (!baseUrl) throw new Error("Missing API Endpoint in Settings.")
  const query = new URLSearchParams({ filename, contentType })
  const resp = await fetch(`${baseUrl}/api/upload-url?${query}`, { headers })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || !data?.uploadUrl || !data?.publicUrl) {
    throw new Error(data?.error || `Upload URL request failed: ${resp.status}`)
  }
  return data
}

export async function queueSparkboardIndex(
  request: SparkboardIndexRequest
): Promise<MediamakeResult> {
  const { result, baseUrl, headers: authHeaders } = await loadConfig()
  if (!baseUrl) {
    return { success: false, message: "Missing API Endpoint in Settings." }
  }

  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...authHeaders
  }

  const projectId =
    typeof result.selectedProjectId === "string" &&
    result.selectedProjectId.trim().length > 0
      ? result.selectedProjectId.trim()
      : typeof request.projectId === "string" &&
        request.projectId.trim().length > 0
      ? request.projectId.trim()
      : undefined

  const tags = normalizeTags(request.tags)
  const input = {
    tags,
    ...(projectId ? { projectId } : {}),
    ...(request.clientId ? { clientId: request.clientId } : {}),
    contentType: request.contentType || "image",
    contentMimeType: request.contentMimeType || "image/jpeg",
    contentSubType: request.contentSubType || "jpeg",
    contentSource: request.contentSource || "pinterest",
    contentSourceUrl:
      request.contentSourceUrl || request.sourceUrl || request.filePath,
    sourceUrl: request.sourceUrl,
    fileName: request.fileName || `pinterest-${Date.now()}.jpg`,
    ...(typeof request.fileSize === "number"
      ? { fileSize: Number(request.fileSize) }
      : {}),
    ...(typeof request.filePath === "string" && request.filePath
      ? { filePath: request.filePath }
      : {}),
    uploadFolder: request.uploadFolder,
    metadata: request.metadata || {},
    analyzeImage: request.analyzeImage === true,
    generateDescription: request.generateDescription === true,
    generateKeywords: request.generateKeywords === true
  }

  const endpoint = `${baseUrl}/api/workflows/workers/sparkboard-index`
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        input,
        await: false
      })
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      return {
        success: false,
        message: data?.error || `Worker dispatch failed: ${resp.status}`
      }
    }
    return { success: true, data }
  } catch (error) {
    return {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Unexpected error while queueing sparkboard worker."
    }
  }
}
