export const handleAndroidBackPriority = (opts: {
  canGoBack: boolean;
  consumeOverlayBack: () => boolean;
  goBack: () => void;
  exitApp: () => void;
}): void => {
  if (opts.consumeOverlayBack()) return;
  if (opts.canGoBack) {
    opts.goBack();
    return;
  }
  opts.exitApp();
};
