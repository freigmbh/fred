// Hands a blob to the browser as a file download. Some browsers read the object URL after the click returns, so it is
// revoked a minute later rather than immediately.
export function saveFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
