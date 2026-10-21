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

export async function queueSparkboardIndex(
  request: SparkboardIndexRequest
): Promise<MediamakeResult> {
  const result = await chrome.storage.local.get([
    "apiEndpoint",
    "apiKey",
    "selectedProjectId"
  ])
  const baseUrl =
    (typeof result.apiEndpoint === "string" && result.apiEndpoint) || ""
  if (!baseUrl || typeof baseUrl !== "string") {
    return { success: false, message: "Missing API Endpoint in Settings." }
  }

  const headers: HeadersInit = {
    "Content-Type": "application/json"
  }
  if (result.apiKey && typeof result.apiKey === "string") {
    headers["Authorization"] = `Bearer ${result.apiKey}`
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
    contentType: "image",
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

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/api/workflows/workers/sparkboard-index`
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
