"use client";

function copyTextWithExecCommand(text: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const existingRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);

    if (selection) {
      selection.removeAllRanges();
      if (existingRange) {
        selection.addRange(existingRange);
      }
    }
  }

  return copied;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (copyTextWithExecCommand(text)) {
    return;
  }

  throw new Error("Clipboard copy is unavailable in this browser.");
}
