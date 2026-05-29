import { useState } from "react"
import "./style.css"

import { MidjourneyTab } from "./componenets/MidjourneyTab"
import { SunoTab } from "./componenets/SunoTab"
import { AgentsTab } from "./componenets/AgentsTab"
import { SettingsTab } from "./componenets/SettingsTab"
import { PinterestTab } from "./componenets/PinterestTab"

type MainTab = "midjourney" | "suno" | "agents" | "settings" | "pinterest"

function IndexPopup() {
  const [activeTab, setActiveTab] = useState<MainTab>("midjourney")

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        padding: 16,
        width: 400
      }}>
      <div style={{ display: "flex", marginBottom: 16, flexWrap: "wrap", gap: 4 }}>
        <button
          onClick={() => setActiveTab("midjourney")}
          style={{
            padding: "8px 12px",
            border: "none",
            backgroundColor: activeTab === "midjourney" ? "#4285F4" : "#E0E0E0",
            color: activeTab === "midjourney" ? "white" : "black",
            cursor: "pointer",
            flex: 1,
            minWidth: "80px",
            fontSize: "12px"
          }}>
          Midjourney
        </button>
        <button
          onClick={() => setActiveTab("pinterest")}
          style={{
            padding: "8px 12px",
            border: "none",
            backgroundColor: activeTab === "pinterest" ? "#E60023" : "#E0E0E0",
            color: activeTab === "pinterest" ? "white" : "black",
            cursor: "pointer",
            flex: 1,
            minWidth: "80px",
            fontSize: "12px"
          }}>
          Pinterest
        </button>
        <button
          onClick={() => setActiveTab("suno")}
          style={{
            padding: "8px 12px",
            border: "none",
            backgroundColor: activeTab === "suno" ? "#4285F4" : "#E0E0E0",
            color: activeTab === "suno" ? "white" : "black",
            cursor: "pointer",
            flex: 1,
            minWidth: "80px",
            fontSize: "12px"
          }}>
          Suno
        </button>
        <button
          onClick={() => setActiveTab("agents")}
          style={{
            padding: "8px 12px",
            border: "none",
            backgroundColor: activeTab === "agents" ? "#4285F4" : "#E0E0E0",
            color: activeTab === "agents" ? "white" : "black",
            cursor: "pointer",
            flex: 1,
            minWidth: "80px",
            fontSize: "12px"
          }}>
          AI Agents
        </button>
        <button
          onClick={() => setActiveTab("settings")}
          style={{
            padding: "8px 12px",
            border: "none",
            backgroundColor: activeTab === "settings" ? "#4285F4" : "#E0E0E0",
            color: activeTab === "settings" ? "white" : "black",
            cursor: "pointer",
            flex: 1,
            minWidth: "80px",
            fontSize: "12px"
          }}>
          Settings
        </button>
      </div>

      {activeTab === "midjourney" && <MidjourneyTab />}
      {activeTab === "suno" && <SunoTab />}
      {activeTab === "agents" && <AgentsTab />}
      {activeTab === "settings" && <SettingsTab />}
      {activeTab === "pinterest" && <PinterestTab />}
    </div>
  )
}

export default IndexPopup


