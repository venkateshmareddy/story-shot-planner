"use client";

import { ModelsSection } from "./models-settings";
import { DataSection, PreferencesSection } from "./settings-view";
import { UsageView } from "./usage-view";
import type { StorySession } from "@/lib/session";

export type SettingsSection = "usage" | "preferences" | "models" | "data";

const NAV: { id: SettingsSection; label: string }[] = [
  { id: "usage", label: "Token usage" },
  { id: "preferences", label: "Preferences" },
  { id: "models", label: "Models" },
  { id: "data", label: "Data & privacy" },
];

export function SettingsScreen({
  section,
  sessions,
  budget,
  onSection,
  onBudgetChange,
  onClearAll,
  onBack,
}: {
  section: SettingsSection;
  sessions: StorySession[];
  budget: number;
  onSection: (section: SettingsSection) => void;
  onBudgetChange: (value: number) => void;
  onClearAll: () => void;
  onBack: () => void;
}) {
  return (
    <div className="settings-screen">
      <nav className="settings-nav" aria-label="Settings sections">
        <button className="settings-back" type="button" onClick={onBack}>
          ← Back to app
        </button>
        <p className="sidebar-section-label">Settings</p>
        <ul className="settings-nav-list">
          {NAV.map((item) => (
            <li key={item.id}>
              <button
                className={`sidebar-nav${section === item.id ? " sidebar-nav-active" : ""}`}
                type="button"
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => onSection(item.id)}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="settings-content">
        {section === "usage" ? (
          <UsageView sessions={sessions} budget={budget} />
        ) : section === "preferences" ? (
          <PreferencesSection budget={budget} onBudgetChange={onBudgetChange} />
        ) : section === "models" ? (
          <ModelsSection />
        ) : (
          <DataSection sessionCount={sessions.length} onClearAll={onClearAll} />
        )}
      </div>
    </div>
  );
}
