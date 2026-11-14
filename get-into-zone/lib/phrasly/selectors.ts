// Everything Browse Hack looks for on Phrasly's humanizer page
// (https://phrasly.ai/dashboard/humanizer), in one place: when Phrasly
// redesigns, this is the file to fix. Labels and aria-labels are preferred
// over class names, which change every build. What each one is was read off
// the live page between 30 Sep and 12 Oct 2026 (the olympus-bridge humanizer,
// which drove this page for months); `phrasly.probe` describes the page as it
// is now, read-only, for when one of these stops matching.

export const PHRASLY = "https://phrasly.ai"
export const HUMANIZER_URL = `${PHRASLY}/dashboard/humanizer`

export const SEL = {
  // The model is a button whose label names it ("Select model: Phrasly Ultra"),
  // opening a "Choose your model" dialog of aria-pressed buttons.
  modelButton: 'button[aria-label^="Select model:" i]',
  modelOptions: '[role="dialog"] button[aria-pressed]',
  // The mode is a range input, 1..5, whose aria-valuetext names the step
  // ("Max": "Strongest rewrite for tough detectors").
  modeSlider: 'input[type="range"][aria-label="Rewrite approach" i]',
  anySlider: 'input[type="range"]',
  // Sentence length and the switches (commas, grammar…) sit in the Text
  // settings dialog, a Headless UI panel with no role, closed with "Done".
  textSettingsButton: 'button[aria-label="Text settings" i]',
  settingsPanels: '[id^="headlessui-dialog-panel"]',
  panelLike: '[id^="headlessui-dialog-panel"], [class*="SettingsPanel"], [role="dialog"]',
  pressed: "button[aria-pressed]",
  switches: '[role="switch"], button[aria-checked], input[type="checkbox"]',
  // The editor the text is pasted into, and the output view: one block of
  // sentence spans.
  editables: 'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
  outputId: "mappedOutput",
  humanizerContainer: "#humanizer-container",
  buttons: 'button, [role="button"]',
  // The drafts of one text: "Next draft", and "Draft 1".."Draft 5" with
  // aria-current on the one shown.
  nextDraft: 'button[aria-label="Next draft" i]',
  currentDraft: 'button[aria-label^="Draft "][aria-current="true"]',
  draftButtons: 'button[aria-label^="Draft "]',
  // Messages the page shows when it won't do a job.
  notices: '[role="alert"], [role="status"], [class*="toast" i], [class*="error" i], [class*="alert" i]',
  overlays: '[role="dialog"], [role="menu"], [role="listbox"]',
  captchaFrames: "iframe"
} as const

/**
 * Where the page keeps its own settings (localStorage, 11 Nov 2026): Text
 * settings as {"moreCommas":false,"sentenceLength":"shorter","cleanerGrammar":false,
 * "proofread":false}, and the Ultra mode ("max_evasion"). Reading them here
 * spares opening the Text settings dialog, which can't finish opening or
 * closing in a background tab (Chrome runs no animation frames there).
 */
export const STORAGE = {
  textSettings: "humanizerUltraSettings",
  mode: "humanizerUltraMode"
} as const

/** Text settings' switches by their storage key, named as the dialog names them. */
export const SWITCH_NAMES: Record<string, string> = {
  moreCommas: "Increase comma count",
  cleanerGrammar: "Cleaner grammar",
  proofread: "Proofread"
}

export const TEXT = {
  // The Humanize button reads "Humanize" ("Humanizing..." while it works).
  // Since 12 Oct a "Humanizer" tool switcher (a menu button) sits above the
  // editor: it must never be taken for it.
  humanize: /^humaniz(?:e|ing)\b/i,
  sentences: /^(longer|shorter)$/i,
  close: /^(close|done)$/i,
  done: /^done$/i,
  // 1 Oct 2026, after 52 humanizations in a day: "Please complete the
  // captcha to continue humanizing your document."
  captcha: /captcha|verify (that )?you('| a)re (a )?human|are you a robot/i,
  captchaFrame: /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|captcha/i,
  // Cloudflare's interstitial, before the page itself loads.
  challengeTitle: /just a moment|attention required/i,
  refusal: /limit|credit|upgrade|subscri|sign ?in|log ?in|too (short|long)|minimum|maximum|error|failed|try again/i,
  signedOutPath: /^\/(login|signup|sign-up|register)\b/i,
  humanizerPath: /\/dashboard\/humanizer\b/i
} as const
