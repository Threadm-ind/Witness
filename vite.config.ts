import { defineConfig, type Plugin } from "vite";

function cspMeta(): Plugin {
  return {
    name: "witness-csp",
    transformIndexHtml(html) {
      if (process.env["WITNESS_DEV"] === "1") return html;
      const tag =
        '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; connect-src \'none\'; img-src \'self\' blob:; font-src \'self\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'" />';
      return html.replace("</head>", `  ${tag}\n  </head>`);
    },
  };
}

export default defineConfig({
  plugins: [cspMeta()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
    port: 4182,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4182,
    strictPort: true,
  },
});
