export const formatPaths = (paths: string[]) => paths.map((path) => {
  const encoded = JSON.stringify(path).replace(/[`\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `\`${encoded}\``;
}).join(", ");
