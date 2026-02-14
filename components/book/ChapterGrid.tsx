import React from "react";

type Props = {
  children: React.ReactNode;
  className?: string;
};

const ChapterGrid: React.FC<Props> = ({ children, className }) => {
  return <div className={className}>{children}</div>;
};

export default ChapterGrid;
