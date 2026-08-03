export function formatToolResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function stripHtml(value) {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function unixToIso(timestamp) {
  if (!timestamp || Number(timestamp) <= 0) {
    return null;
  }

  return new Date(Number(timestamp) * 1000).toISOString();
}

export function previewText(value, maxLength = 1200) {
  const text = stripHtml(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function redactSensitive(value) {
  return String(value ?? "")
    .replace(/([?&](?:code|state|token|ctx|canary|flowToken|PPFT|session_state)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(?:^|;\s*)([^=;\s]*(?:token|session|cookie|auth|asp\.net)[^=;\s]*)=[^;\s]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]");
}
