// Everything Browse Hack looks for on studio.tripo3d.ai's pages, in one place:
// when Tripo redesigns, this is the file to fix. Tripo's buttons mostly carry
// no labels (icons, Reka UI tooltips), so these lean on their text, roles and
// data-state, read on the live site on 12 Nov 2026.

export const SEL = {
  // The create form (/workspace/generate), left panel.
  /** The four input-mode tabs: image, multiview, batch, text (pencil, last). */
  inputTabs: 'button[class*="rounded-32"][class*="w-1/2"]',
  prompt: 'textarea[maxlength="1000"]',
  fileInput: 'input[type="file"]',
  combobox: 'button[role="combobox"]',
  option: '[role="option"]',
  switch: '[role="switch"]',
  dialog: '[role="dialog"]',
  button: "button",
  // A gallery card or a related model links to its page.
  modelLink: 'a[href^="/3d-model/"]',
  // Cloudflare Turnstile and the like, when they show.
  captchaFrames:
    'iframe[src*="challenges.cloudflare.com"], iframe[src*="hcaptcha.com"], iframe[src*="recaptcha"], iframe[title*="challenge" i]'
} as const

export const TEXT = {
  generate: /^generate\b/i,
  tPose: /^t-?pose$/i,
  hdModel: /^hd model$/i,
  geometry: /^geometry\s*&\s*texture/i,
  texture: "Texture",
  textureQuality: "Texture Quality",
  removeLighting: "Remove Lighting",
  pbr: "PBR",
  topology: "Topology",
  quad: "Quad",
  triangle: "Triangle",
  // The model picker's options: "H3.1 – Best Quality", "H2.5 – Legacy".
  modelOption: /^\s*(H\d+(?:\.\d+)?|Nexus\s*\d+(?:\.\d+)?)\b/i,
  privacy: /^(public|private)$/i,
  // The viewer's toolbar and its Export dialog.
  export: /^export\b/i,
  exportDialog: /^export\b/i,
  glb: /^glb$/i,
  // What Tripo shows instead of exporting or generating for someone who may not.
  upgrade: /upgrade|members?\s*only|subscribe|join (pro|membership)|unlock/i,
  notEnoughCredits: /not enough credits|insufficient credits|credits? (are|is) not enough|out of credits/i,
  busy: /task(s)? (is|are) (still )?(running|in progress)|concurrent|queue is full|one task at a time/i,
  signIn: /^(sign up\/log in|log in|sign in)$/i
} as const

export const WORKSPACE_URL = "https://studio.tripo3d.ai/workspace/generate"
