import { useCallback, useMemo, useState } from "react";
import type { ReaderSettings, Theme } from "../../../types";

type Params = {
  highlightEnabled: boolean;
  highlightReady: boolean;
  readerSettings: ReaderSettings;
  isMobile: boolean;
  theme: Theme;
};

export function useReaderState(params: Params) {
  const { highlightEnabled, highlightReady, readerSettings, isMobile } = params;
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [resumeNudge, setResumeNudge] = useState(0);

  const autoFollowEnabled = useMemo(() => {
    return highlightEnabled && readerSettings.followHighlight && highlightReady;
  }, [highlightEnabled, highlightReady, readerSettings.followHighlight]);

  const showResumeButton = isMobile && autoFollowEnabled && isUserScrolling;

  const handleResumeAutoScroll = useCallback(() => {
    setIsUserScrolling(false);
    setResumeNudge((n) => n + 1);
  }, []);

  return {
    autoFollowEnabled,
    showResumeButton,
    resumeNudge,
    isUserScrolling,
    setIsUserScrolling,
    handleResumeAutoScroll,
  };
}
