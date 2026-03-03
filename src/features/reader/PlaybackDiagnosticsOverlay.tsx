import React, { useState, useEffect, useRef } from "react";
import { Terminal } from "lucide-react";
import { usePlaybackTick } from "../../app/state/PlaybackTickContext";

const DISPLAY_THROTTLE_MS = 500;

interface PlaybackDiagnosticsOverlayProps {
  playbackPhase: string;
  chapterSession: number;
  /** Pass when not using context (e.g. tests); otherwise read from PlaybackTickContext */
  audioDuration: number;
  autoplayBlocked: boolean;
  isMobile: boolean;
}

export default function PlaybackDiagnosticsOverlay({
  playbackPhase,
  chapterSession,
  audioDuration,
  autoplayBlocked,
  isMobile,
}: PlaybackDiagnosticsOverlayProps) {
  const { audioCurrentTime } = usePlaybackTick();
  const [displayTime, setDisplayTime] = useState(audioCurrentTime);
  const latestTimeRef = useRef(audioCurrentTime);
  latestTimeRef.current = audioCurrentTime;

  useEffect(() => {
    const id = setInterval(() => {
      setDisplayTime(latestTimeRef.current);
    }, DISPLAY_THROTTLE_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="fixed top-20 right-4 z-[1000] p-4 bg-black/80 backdrop-blur-md text-white text-[10px] font-mono rounded-xl shadow-2xl border border-white/10 pointer-events-none opacity-80">
      <div className="flex items-center gap-2 mb-2 border-b border-white/20 pb-1">
        <Terminal className="w-3 h-3 text-indigo-400" />
        <span className="font-bold">Playback Diagnostics {isMobile ? "(Mobile)" : ""}</span>
      </div>
      <div>
        Phase: <span className="text-emerald-400">{playbackPhase}</span>
      </div>
      <div>Session: {chapterSession}</div>
      <div>Audio Time: {displayTime.toFixed(2)}s</div>
      <div>Duration: {audioDuration.toFixed(2)}s</div>
      <div>Blocked: {autoplayBlocked ? "YES" : "NO"}</div>
    </div>
  );
}
