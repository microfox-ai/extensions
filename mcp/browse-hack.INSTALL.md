# Browse Hack: setup

The Chrome extension is already loaded (the step before this one) and the
MCP is added: from the `.mcpb` in Claude Desktop, or with `claude mcp add`
in Claude Code (install step 4).

1. Ask the person to open the Browse Hack popup (puzzle-piece icon →
   **Browse Hack**; pin it while they're there). Every feature needs it
   signed in to MediaMake:
   - If `$MEDIAMAKE_URL` isn't `https://mediamake.microfox.app`, first set
     **Mediamake URL** at the bottom of the sign-in screen to it.
   - Click **Sign in to Mediamake**, sign in in the window that opens and
     click **Allow**. No API key is needed; they stay signed in while they use
     it (30 days after they last use it).
   - Then, in **Settings**, they can pick a **Default Project** for saves.
   Skip this if Settings already shows them signed in.
2. Make the tools show up:
   - Claude Desktop: if it was open while the MCP was installed, ask them to
     quit and reopen it.
   - Claude Code: `claude mcp get browse-hack` should say Connected. The
     tools load in the next Claude Code session, so tell them to start one.
3. Check it works: call the MCP's `get_status` tool (in Claude Code, from
   that new session if this one doesn't have it). It should list the
   extension in each Chrome profile it's loaded in, and the popup's
   **Settings → Let Claude use this extension (MCP)** shows Connected to
   Claude. If it isn't connected, ask them to keep a Chrome window open with
   the extension enabled, and reload it on `chrome://extensions`. If one
   profile shows up twice with two `extensionId`s, an older copy is still
   loaded: ask them to **Remove** the card whose ID isn't the new one on
   `chrome://extensions`.
4. First thing to try: "Open Midjourney in a new tab and queue this prompt: …"
