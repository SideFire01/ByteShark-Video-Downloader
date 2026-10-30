import preact from "@preact/preset-vite";
import { defineConfig } from "wxt";

export default defineConfig({
  vite: () => ({
    plugins: [preact()],
  }),
  hooks: {
    "build:manifestGenerated": (_wxt, manifest) => {
      if (manifest.action) delete manifest.action.default_popup;
    },
  },
  manifest: {
    name: "ByteShark Video Downloader",
    version: "0.1.0",
    permissions: [
      "downloads",
      "webRequest",
      "declarativeNetRequest",
      "offscreen",
      "storage",
      "scripting",
      "sidePanel",
    ],
    host_permissions: ["<all_urls>"],
    side_panel: { default_path: "sidepanel.html" },
    minimum_chrome_version: "123",
  },
});
