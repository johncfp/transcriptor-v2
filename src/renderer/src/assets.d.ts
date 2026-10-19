// Vite handles CSS imports; this lets TypeScript accept them.
declare module "*.css";
// `?url` imports (the bundled caption fonts): Vite gives the file's URL.
declare module "*?url" {
  const url: string;
  export default url;
}
// Vite's glob import (the Chinese caption font's pieces), typed for the eager form used here.
interface ImportMeta {
  glob<T = unknown>(pattern: string, options: { eager: true; query?: string; import?: string }): Record<string, T>;
}
