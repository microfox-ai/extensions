// What suno.com's own Create request asked for, read from its body in the page
// (contents/sunoPage.ts). Only these settings leave the page: never the body
// itself, whose captcha and session tokens stay there.

export type SentVocalGender = "male" | "female" | "none"

export interface SentSettings {
  /** metadata.vocal_gender: "f" / "m", or "none" when the request had no vocal gender. */
  vocalGender: SentVocalGender
  /** mv: the model's key (chirp-hawk = v6, chirp-hawk-wild = v6-wild, chirp-goose = v6-mini). */
  modelKey?: string
}

/** The settings a Create request's JSON body asked for, or undefined when it isn't JSON. */
export function sentSettings(body: unknown): SentSettings | undefined {
  let data: any = body
  if (typeof body === "string") {
    try {
      data = JSON.parse(body)
    } catch {
      return undefined
    }
  }
  if (!data || typeof data !== "object") return undefined
  const gender = String(data.metadata?.vocal_gender ?? "").toLowerCase()
  return {
    vocalGender: gender === "f" || gender === "female" ? "female" : gender === "m" || gender === "male" ? "male" : "none",
    modelKey: typeof data.mv === "string" ? data.mv : undefined
  }
}

/**
 * A warning when the request didn't ask for the vocal gender the job wanted, or
 * couldn't be read; undefined when it asked for it (or the job wanted none).
 */
export function vocalGenderWarning(wanted: string | undefined, sent: SentVocalGender | undefined) {
  if (!wanted || sent === wanted) return undefined
  if (!sent) return `couldn't read the vocal gender Suno's Create request asked for (${wanted} was set on the form)`
  return sent === "none"
    ? `Suno's Create request had no vocal gender, not ${wanted}: the takes may not have ${wanted} vocals`
    : `Suno's Create request asked for ${sent} vocals, not ${wanted}`
}
