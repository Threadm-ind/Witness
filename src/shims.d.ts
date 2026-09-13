/// <reference types="vite/client" />

declare module "*.js?raw" {
  const src: string;
  export default src;
}

declare module "*.css?inline" {
  const src: string;
  export default src;
}
