import React from "react";
import type { Theme } from "../../types";
import type { RenderBlock } from "../../utils/markdownBlockParser";
import ReaderList from "../ReaderList";

type Props = {
  header?: React.ReactNode;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onDoubleClick: () => void;
  containerStyles: React.CSSProperties;
  spacerClassName: string;
  blocks: RenderBlock[];
  activeCueRange: { start: number; end: number } | null;
  autoFollow: boolean;
  isScrubbing: boolean;
  followNudge: number;
  onUserScrollingChange: (v: boolean) => void;
  theme: Theme;
  followHighlight: boolean;
};

const ReaderContent: React.FC<Props> = ({
  header,
  containerRef,
  onScroll,
  onDoubleClick,
  containerStyles,
  spacerClassName,
  blocks,
  activeCueRange,
  autoFollow,
  isScrubbing,
  followNudge,
  onUserScrollingChange,
  theme,
  followHighlight,
}) => {
  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className={`flex-1 overflow-y-auto overscroll-contain touch-pan-y px-4 lg:px-12 py-12 lg:py-24 scrollbar-hide ${followHighlight ? '' : 'scroll-smooth'}`}
      onDoubleClick={onDoubleClick}
    >
      <div
        style={containerStyles}
        className="max-w-[70ch] mx-auto pb-64 select-text cursor-text font-medium leading-relaxed"
      >
        {header}
        <ReaderList
          blocks={blocks}
          activeCueRange={activeCueRange}
          autoFollow={autoFollow}
          isScrubbing={isScrubbing}
          followNudge={followNudge}
          containerRef={containerRef}
          onUserScrollingChange={onUserScrollingChange}
          theme={theme}
          spacerClassName={spacerClassName}
        />
      </div>
    </div>
  );
};

export default ReaderContent;
