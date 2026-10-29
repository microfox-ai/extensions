import { useState, type ComponentType } from "react"
import "./style.css"

import { MidjourneyTab } from "./componenets/MidjourneyTab"
import { SunoTab } from "./componenets/SunoTab"
import { AgentsTab } from "./componenets/AgentsTab"
import { SaverTab } from "./componenets/SaverTab"
import { SettingsTab } from "./componenets/SettingsTab"
import { PinterestTab } from "./componenets/PinterestTab"
import { YouTubeTab } from "./componenets/YouTubeTab"
import { InstagramTab } from "./componenets/InstagramTab"
import { DistroKidTab } from "./componenets/DistroKidTab"
import { SignInScreen, useAuthState } from "./componenets/SignInScreen"

type MainTab =
  | "midjourney"
  | "pinterest"
  | "youtube"
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
    id: "youtube",
    label: "YouTube",
    activeColor: "#FF0000",
    component: YouTubeTab
  },
  {
    id: "instagram",
    label: "Instagram",
    activeColor: "#E1306C",
    component: InstagramTab
  },
  { id: "suno", label: "Suno", component: SunoTab, hidden: true },
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
