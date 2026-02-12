export function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }

  // Fallback: at least preserve ASCII correctly (rare; modern Android/WebView supports TextDecoder).
  try {
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) {
      out += String.fromCharCode(bytes[i]);
    }
    return out;
  } catch {
    return "";
  }
}

