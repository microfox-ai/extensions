import type { PlasmoCSConfig } from "plasmo"

import { readDistrokidAlbum } from "../lib/distrokidPage"

export const config: PlasmoCSConfig = {
  matches: [
    "https://distrokid.com/dashboard/album/*",
    "https://www.distrokid.com/dashboard/album/*"
  ],
  run_at: "document_idle"
}

// A "Sync links" button in Delivered to, shown only when a MediaMake Library
// record is linked to this release (its distrokid group's link names it).

const BUTTON_ID = "giz-distrokid-sync"

type Linked = { spaceId: string; space: string; ref: string; title: string }

function ask<T>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "distrokid-ui", op, ...extra }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
      if (!response?.ok) return reject(new Error(response?.error || "Browse Hack did not answer."))
      resolve(response.result as T)
    })
  })
}

function deliveredSection(): HTMLElement | null {
  const icons = document.querySelector<HTMLElement>(".store-icons")
  return (
    (icons?.closest(".section-body") as HTMLElement | null) ||
    (icons?.parentElement as HTMLElement | null) ||
    null
  )
}

async function waitForSection(ms = 15_000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const section = deliveredSection()
    if (section) return section
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return null
}

async function mount() {
  const albumUuid = new URL(location.href).searchParams.get("albumuuid") || ""
  if (!albumUuid || document.getElementById(BUTTON_ID)) return
  let records: Linked[] = []
  try {
    records = await ask<Linked[]>("linked", { albumUuid })
  } catch {
    // Signed out of MediaMake, or no Library: no button.
    return
  }
  if (!records.length) return
  const section = await waitForSection()
  if (!section || document.getElementById(BUTTON_ID)) return

  const box = document.createElement("div")
  box.id = BUTTON_ID
  box.style.cssText =
    "margin:12px 0;display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:13px;line-height:1.4;"
  const button = document.createElement("button")
  button.type = "button"
  button.className = "buttonSmall dashboard-button white-button"
  button.style.cssText = "cursor:pointer;padding:6px 12px;"
  const names = records.map((record) => `${record.title} (${record.space})`).join(", ")
  button.textContent = "Sync links to MediaMake"
  button.title = `Saves this release's store links, DistroKid link and UPC to: ${names}`
  const note = document.createElement("span")
  note.style.color = "#555"
  note.textContent = `Linked: ${names}`
  box.append(button, note)
  section.prepend(box)

  button.addEventListener("click", async () => {
    button.disabled = true
    note.style.color = "#555"
    note.textContent = "Reading this release…"
    try {
      const album = await readDistrokidAlbum({ lyrics: false, credits: false })
      if (!album.storeLinks.length) {
        note.textContent = "No store links on this page yet. Nothing was synced."
        return
      }
      note.textContent = "Saving to MediaMake…"
      const results = await ask<{ ref: string; space: string; ok: boolean; message: string }[]>("sync", {
        album
      })
      const failed = results.filter((item) => !item.ok)
      note.style.color = failed.length ? "#9f1239" : "#047857"
      note.textContent = results
        .map((item) => `${item.ref} (${item.space}): ${item.ok ? item.message : `failed, ${item.message}`}`)
        .join(" · ")
    } catch (error) {
      note.style.color = "#9f1239"
      note.textContent = error instanceof Error ? error.message : "Sync failed."
    } finally {
      button.disabled = false
    }
  })
}

void mount()
