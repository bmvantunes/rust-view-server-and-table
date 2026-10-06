export function isBrunoTableDocumentFocusChainActive(ownerDocument: Document): boolean {
  let currentDocument = ownerDocument;
  for (;;) {
    const currentWindow = currentDocument.defaultView;
    if (currentWindow === null) return false;
    let frameElement: Element | null;
    try {
      frameElement = currentWindow.frameElement;
    } catch {
      return false;
    }
    if (frameElement === null) {
      let parentWindow: Window;
      try {
        parentWindow = currentWindow.parent;
      } catch {
        return false;
      }
      return parentWindow === currentWindow && currentDocument.hasFocus();
    }
    const parentDocument = frameElement.ownerDocument;
    if (parentDocument.activeElement !== frameElement) return false;
    currentDocument = parentDocument;
  }
}
