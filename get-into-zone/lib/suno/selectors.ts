// Everything Browse Hack looks for on suno.com's pages, in one place: when Suno
// redesigns, this is the file to fix (NOTES.md has what each one is). Labels
// and aria-labels are preferred over class names, which change every build.

export const SEL = {
  createButton: 'button[aria-label="Create song"]',
  clearForm: 'button[aria-label="Clear all form inputs"]',
  credits: 'button[aria-label^="Credits remaining"]',
  addAudio: 'button[aria-label^="Add audio"]',
  audioFileInput: 'input[type="file"][accept*="audio"]',
  conditionType: 'button[aria-label^="Change condition type"]',
  clearCondition: 'button[aria-label="Clear audio condition"]',
  lyrics: '[aria-label="Lyrics editor"]',
  clearStyles: 'button[aria-label="Clear styles"]',
  stylesFallback: 'textarea[maxlength="1000"]',
  excludeStyles: 'input[placeholder="Exclude styles"]',
  title: 'input[placeholder^="Song Title"]',
  slider: (label: string) => `[role="slider"][aria-label="${label}"]`,
  songLink: 'a[href^="/song/"]',
  // A song in a list (Create, Library, workspaces) and its "…" button.
  clipRow: '[data-testid="clip-row"]',
  moreOptions: 'button[aria-label="More options"]',
  menuItems: '[role="menuitem"], [role="menu"] button, [role="option"]',
  // Menus and the pickers (model, workspace) open as these.
  popups: '[role="dialog"], [role="menu"], [role="listbox"]',
  clickable: '[role="option"], [role="menuitem"], [role="row"], [role="gridcell"], button, [role="button"], li, a',
  // Cloudflare Turnstile and hCaptcha challenges, when they show.
  captchaFrames: 'iframe[src*="challenges.cloudflare.com"], iframe[src*="hcaptcha.com"]'
} as const

/** The labels of the Create form's More Options rows and their buttons. */
export const ROW = {
  vocalGender: { label: "Vocal Gender", male: "Male", female: "Female" },
  duration: { label: "Duration", custom: "Custom", auto: "Auto" },
  maxMode: { label: "Max Mode", off: "Off", on: "On" },
  myTaste: { label: "My Taste", off: "Off", on: "On" }
} as const

export const SLIDERS = {
  weirdness: "Weirdness",
  styleInfluence: "Style Influence",
  audioInfluence: "Audio Influence",
  variety: "Variety"
} as const

export const TEXT = {
  songsTab: "Songs",
  advanced: "Advanced",
  moreOptions: "More Options",
  upload: "Upload",
  download: "Download",
  // A song's "…" menu button carries no label; it is the last button in its row.
  remix: "Remix",
  extendFrom: "Extend from",
  // The label above the workspace button.
  saveTo: "Save to"
} as const

/**
 * Suno's download dialog, which a song's Download opens since downloads are
 * metered: one toggle per format (several can be on; M4A starts on on a Mac,
 * MP3 elsewhere), then "Unlock & Download" for a song not downloaded yet, or
 * "Download" for one that is (no download used).
 */
export const DOWNLOAD = {
  formats: { m4a: "M4A", mp3: "MP3", wav: "WAV", video: "Video" },
  confirm: /^(unlock\s*(&|and|\+)\s*)?download$/i,
  // Other buttons in the dialog that say "download".
  notConfirm: /buy|purchase|pack|share|link|stems|upgrade/i,
  outOfDownloads: /out of downloads|no downloads (left|remaining)/i,
  // Before the dialog, the song menu had Download ▸ MP3 Audio / WAV Audio / Video.
  menu: { mp3: /\bmp3\b|^audio$/i, wav: /\bwav\b/i }
} as const

/** Condition names in the audio condition menu, by remix_type. */
export const CONDITIONS: Record<string, string> = {
  cover: "Cover",
  extend: "Extend",
  mashup: "Mashup",
  sample: "Sample",
  inspo: "Inspo"
}
