export const stripUnityMarkup = (value: string): string =>
  value
    .replace(/<color=[^>]+>/gi, "")
    .replace(/<\/color>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\{effects\[(\d+)]\.value\/100:F1%?\}/g, "—")
    .replace(/\{[^}]+\}/g, "—")
    .replace(/\\n/g, "\n")
    .trim();
