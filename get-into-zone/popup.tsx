import { useEffect, useState, type ComponentType } from "react"
import "./style.css"

import { MidjourneyTab } from "./componenets/MidjourneyTab"
import { SunoTab } from "./componenets/SunoTab"
import { AgentsTab } from "./componenets/AgentsTab"
import { SaverTab } from "./componenets/SaverTab"
import { SettingsTab } from "./componenets/SettingsTab"
import { PinterestTab } from "./componenets/PinterestTab"
import { GoogleImagesTab } from "./componenets/GoogleImagesTab"
import { YouTubeTab } from "./componenets/YouTubeTab"
import { InstagramTab } from "./componenets/InstagramTab"
import { DistroKidTab } from "./componenets/DistroKidTab"
import { StudioTab } from "./componenets/StudioTab"
import { SignInScreen, useAuthState } from "./componenets/SignInScreen"
import { isGoogleImagesUrl } from "./lib/googleImages"
import { isPinterestHost } from "./lib/saverRules"

type MainTab =
  | "midjourney"
  | "pinterest"
  | "googleImages"
  | "youtube"
  | "studio"
  | "instagram"
  | "suno"
  | "distrokid"
  | "agents"
  | "saver"
  | "settings"

// Set `hidden: true` to drop a tab from the header without deleting it.
const TABS: {
  id: MainTab
  label: string
  activeColor?: string
  component: ComponentType
  hidden?: boolean
}[] = [
  { id: "midjourney", label: "Midjourney", component: MidjourneyTab },
  {
    id: "pinterest",
    label: "Pinterest",
    activeColor: "#E60023",
    component: PinterestTab
  },
  {
    id: "googleImages",
    label: "Google Images",
    activeColor: "#1a73e8",
    component: GoogleImagesTab
  },
  {
    id: "youtube",
    label: "YouTube",
    activeColor: "#FF0000",
    component: YouTubeTab
  },
  {
    id: "studio",
    label: "YouTube Studio",
    activeColor: "#CC0000",
    component: StudioTab
  },
  {
    id: "instagram",
    label: "Instagram",
    activeColor: "#E1306C",
    component: InstagramTab
  },
  { id: "suno", label: "Suno", activeColor: "#F97316", component: SunoTab },
  {
    id: "distrokid",
    label: "DistroKid",
    activeColor: "#0073C7",
    component: DistroKidTab
  },
  { id: "agents", label: "AI Agents", component: AgentsTab, hidden: true },
  { id: "saver", label: "Saver", component: SaverTab },
  { id: "settings", label: "Settings", component: SettingsTab }
]

const popupStyle = {
  display: "flex",
  flexDirection: "column" as const,
  padding: 16,
  width: 400
}

function IndexPopup() {
  const [activeTab, setActiveTab] = useState<MainTab>("midjourney")
  const auth = useAuthState()
  const visibleTabs = TABS.filter((tab) => !tab.hidden)
  const ActiveComponent = TABS.find((tab) => tab.id === activeTab)!.component

  // Opened on a Google Images search or on Pinterest, the popup starts on that
  // tab, where its bulk download is.
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      const url = tab?.url ?? ""
      if (isGoogleImagesUrl(url)) setActiveTab("googleImages")
      else {
        try {
          if (isPinterestHost(new URL(url).hostname)) setActiveTab("pinterest")
        } catch {
          // Not a web page.
        }
      }
    })
  }, [])

  if (!auth) return <div style={popupStyle} />
  if (!auth.signedIn) {
    return (
      <div style={popupStyle}>
        <SignInScreen endpoint={auth.endpoint} />
      </div>
    )
  }

  return (
    <div style={popupStyle}>
      <div style={{ display: "flex", marginBottom: 16, flexWrap: "wrap", gap: 4 }}>
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "8px 12px",
              border: "none",
              backgroundColor:
                activeTab === tab.id ? tab.activeColor ?? "#4285F4" : "#E0E0E0",
              color: activeTab === tab.id ? "white" : "black",
              cursor: "pointer",
              flex: 1,
              minWidth: "80px",
              fontSize: "12px"
            }}>
            {tab.label}
          </button>
        ))}
      </div>

      <ActiveComponent />
    </div>
  )
}

export default IndexPopup
