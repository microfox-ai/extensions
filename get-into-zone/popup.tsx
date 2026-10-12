import { useState, type ComponentType } from "react"
import "./style.css"

import { MidjourneyTab } from "./componenets/MidjourneyTab"
import { SunoTab } from "./componenets/SunoTab"
import { AgentsTab } from "./componenets/AgentsTab"
import { SaverTab } from "./componenets/SaverTab"
import { SettingsTab } from "./componenets/SettingsTab"
import { PinterestTab } from "./componenets/PinterestTab"

type MainTab =
  | "midjourney"
  | "pinterest"
  | "suno"
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
  { id: "suno", label: "Suno", component: SunoTab, hidden: true },
  { id: "agents", label: "AI Agents", component: AgentsTab, hidden: true },
  { id: "saver", label: "Saver", component: SaverTab },
  { id: "settings", label: "Settings", component: SettingsTab }
]

function IndexPopup() {
  const [activeTab, setActiveTab] = useState<MainTab>("midjourney")
  const visibleTabs = TABS.filter((tab) => !tab.hidden)
  const ActiveComponent = TABS.find((tab) => tab.id === activeTab)!.component

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        padding: 16,
        width: 400
      }}>
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
