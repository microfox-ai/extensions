# Get into zone: setup

The Chrome extension is already loaded (the step before this one) and the
MCP is added: from the `.mcpb` in Claude Desktop, or with `claude mcp add`
in Claude Code (install step 4).

1. Ask the person to open the Get into zone popup (puzzle-piece icon →
   **Get into zone**; pin it while they're there), go to **Settings**, and fill in:
   - **API Endpoint**: their MediaMake URL (`$MEDIAMAKE_URL` from install step 0)
   - **API Key**: their MediaMake API key, which they copy from
     `$MEDIAMAKE_URL/core/api-keys` and paste themselves (an install code is
     not an API key; never put it here)
   - **Default Project**: any MediaMake project they want saves to go to
   Then **Save Settings**. Skip this if they kept an extension that was
   already set up.
2. Make the tools show up:
   - Claude Desktop: if it was open while the MCP was installed, ask them to
     quit and reopen it.
   - Claude Code: `claude mcp get get-into-zone` should say Connected. The
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
