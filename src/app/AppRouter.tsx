import React from "react";

export type AppRouterProps = {
  activeTab: "library" | "collection" | "reader" | "rules" | "settings";
  renderLibrary: () => React.ReactNode;
  renderCollection: () => React.ReactNode;
  renderReader: () => React.ReactNode;
  renderRules: () => React.ReactNode;
  renderSettings: () => React.ReactNode;
};

const AppRouter: React.FC<AppRouterProps> = ({
  activeTab,
  renderLibrary,
  renderCollection,
  renderReader,
  renderRules,
  renderSettings,
}) => {
  if (activeTab === "library") return <>{renderLibrary()}</>;
  if (activeTab === "collection") return <>{renderCollection()}</>;
  if (activeTab === "reader") return <>{renderReader()}</>;
  if (activeTab === "rules") return <>{renderRules()}</>;
  if (activeTab === "settings") return <>{renderSettings()}</>;
  return null;
};

export default AppRouter;
