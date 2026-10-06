// Vite handles CSS imports; this lets TypeScript accept them.
declare module "*.css";
// `?url` imports (the bundled caption fonts): Vite gives the file's URL.
declare module "*?url" {
  const url: string;
  export default url;
}
