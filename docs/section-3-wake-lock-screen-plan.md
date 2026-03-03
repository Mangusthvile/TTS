# Section 3 — Wake Lock & Screen

Reduce heat from the combination of screen-on (Keep Awake) and playback wake lock by keeping the default off, documenting the tradeoff in Settings, and clarifying behavior in code.

---

## Current behavior

- **Keep Awake:** [hooks/useKeepAwake.ts](hooks/useKeepAwake.ts) calls `KeepAwake.keepAwake()` (native: FLAG_KEEP_SCREEN_ON) or `navigator.wakeLock.request("screen")` (web) when `keepAwake` is true. The screen stays on and does not dim/sleep. The display is a major heat source; keeping it on during long playback increases temperature and battery use.
- **Default:** [App.tsx](App.tsx) line 491 sets `keepAwake: parsed.keepAwake ?? false`, so when the user has never saved a value, the default is **off**. No code change is needed to "default off"; we only need to keep it that way and make the tradeoff visible.
- **ExoPlayer WAKE_MODE_LOCAL:** [NativePlayerService.java](android/app/src/main/java/com/cmwil/talevox/player/NativePlayerService.java) line 32: `player.setWakeMode(C.WAKE_MODE_LOCAL)`. This holds a **partial** CPU wake lock so audio continues when the screen is off. This is correct and required for background playback; we do **not** change or remove it.
- **Combination:** When Keep Awake is **on**, the screen is kept on (FLAG_KEEP_SCREEN_ON) and playback also holds WAKE_MODE_LOCAL. Both are active at once: full screen + CPU wake lock, which maximizes heat during playback. When Keep Awake is **off**, only WAKE_MODE_LOCAL runs (audio in background with screen off), which is the expected, lower-heat case.

---

## 1. Keep default off and document (App.tsx)

- **Current:** `keepAwake: parsed.keepAwake ?? false` — default is already off.
- **Change:** Add a short comment next to that line stating that the default is intentionally `false` to reduce device temperature and battery use; users can enable it in Settings if they want the screen to stay on.
- **Location:** [App.tsx](App.tsx) around line 491, same line or the line above.

---

## 2. Settings: note about temperature and battery (Settings.tsx)

- **Current:** The "Keep Awake" row has title "Keep Awake" and subtitle "Prevent screen sleep" (lines 904–905). No mention of heat or battery.
- **Change:** Add a single line of helper text under "Prevent screen sleep" (or as part of the subtitle) so users understand the tradeoff, e.g. "May increase device temperature and battery use." Keep the label and checkbox as they are; only add this note.
- **Location:** [components/Settings.tsx](components/Settings.tsx), in the same label/block as the Keep Awake checkbox (around lines 895–914). For example, add a second line in the description div with `text-[10px] opacity-60` so it matches the existing "Prevent screen sleep" style.

---

## 3. NativePlayerService: comment about wake mode (NativePlayerService.java)

- **Current:** `player.setWakeMode(C.WAKE_MODE_LOCAL);` with no comment.
- **Change:** Add a one- or two-line comment above that call: WAKE_MODE_LOCAL is required so audio continues with the screen off; when the user also enables "Keep screen on" (Keep Awake), both the screen and this wake lock are active, which can increase device temperature.
- **Location:** [android/app/src/main/java/com/cmwil/talevox/player/NativePlayerService.java](android/app/src/main/java/com/cmwil/talevox/player/NativePlayerService.java), immediately before the `setWakeMode` line. No behavior change; documentation only.

---

## 4. No change to ExoPlayer wake mode

- **WAKE_MODE_LOCAL** stays as-is. Changing or removing it would break background audio when the screen turns off. The plan only documents it and reduces the default "screen on" path (Keep Awake off by default + Settings note).

---

## Implementation order

| Step | Task | File(s) |
|------|------|--------|
| 1 | Add comment that keepAwake defaults to false to reduce heat/battery | [App.tsx](App.tsx) |
| 2 | Add helper text in Settings: "May increase device temperature and battery use" for Keep Awake | [components/Settings.tsx](components/Settings.tsx) |
| 3 | Add comment in NativePlayerService above setWakeMode about WAKE_MODE_LOCAL and heat when combined with Keep Awake | [NativePlayerService.java](android/app/src/main/java/com/cmwil/talevox/player/NativePlayerService.java) |

---

## Verification

- **Default:** New or cleared state: Keep Awake is off; screen can sleep during playback unless the user turns it on.
- **Settings:** Keep Awake toggle still works; new note is visible and readable.
- **Playback:** With Keep Awake off, audio continues in background with screen off (WAKE_MODE_LOCAL unchanged). With Keep Awake on, screen stays on as before.

---

## Summary

- **Default:** Confirmed off (`keepAwake ?? false`), with a short comment in App.tsx.
- **Settings:** One line of text explaining that Keep Awake may increase device temperature and battery use.
- **NativePlayerService:** Comment only; WAKE_MODE_LOCAL unchanged so background audio remains correct.

No features are removed; only documentation and one UX note are added.
