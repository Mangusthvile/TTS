import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Settings from "../components/Settings";
import { HighlightMode, Theme } from "../types";

describe("Settings backup section", () => {
  it("renders backup controls when backup section is expanded", async () => {
    const user = userEvent.setup();
    render(
      <Settings
        settings={{
          fontFamily: "serif",
          fontSizePx: 20,
          lineHeight: 1.5,
          paragraphSpacing: 1,
          reflowLineBreaks: true,
          highlightColor: "#4f46e5",
          followHighlight: true,
          highlightEnabled: true,
          highlightMode: HighlightMode.SENTENCE,
          uiMode: "mobile",
        }}
        onUpdate={vi.fn()}
        theme={Theme.DARK}
        onSetTheme={vi.fn()}
        keepAwake={false}
        onSetKeepAwake={vi.fn()}
        onCheckForUpdates={vi.fn()}
        autoSaveInterval={30}
        onSetAutoSaveInterval={vi.fn()}
        showDiagnostics={false}
        onSetShowDiagnostics={vi.fn()}
        backupOptions={{
          includeAudio: true,
          includeDiagnostics: true,
          includeAttachments: true,
          includeChapterText: true,
          includeOAuthTokens: false,
        }}
        onUpdateBackupOptions={vi.fn()}
        onBackupToDrive={vi.fn()}
        onBackupToDevice={vi.fn()}
        onRestoreFromFile={vi.fn()}
        onLoadDriveBackups={vi.fn()}
        onRestoreFromDriveBackup={vi.fn()}
        backupSettings={{
          autoBackupToDrive: false,
          autoBackupToDevice: false,
          backupIntervalMin: 30,
          keepDriveBackups: 10,
          keepLocalBackups: 10,
        }}
        onUpdateBackupSettings={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /backup and restore/i }));
    expect(screen.getByRole("button", { name: /backup to drive/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /backup to device/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /restore from file/i })).toBeInTheDocument();
  });
});

