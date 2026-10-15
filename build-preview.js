// Builds one self-contained HTML page (no doctype/head/body) for the Claude artifact preview.
// Usage: node build-preview.js <out.html> [phone-app-url]
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "app");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const html = read("index.html");
const body = html.split("<!-- BODY START -->")[1].split("<!-- BODY END -->")[0]
  .replace(/<script src="([^"]+)"><\/script>/g, (_, f) => `<script>\n${read(f)}\n</script>`);
const url = process.argv[3] || "";
const out = [
  "<title>Fleeto Ride Score</title>",
  '<meta name="claude:viewport-fit-sides" content="cover">',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;600&family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Mono&display=swap">',
  `<style>\n${read("style.css")}\n</style>`,
  url ? `<script>window.FLEETO_PHONE_APP_URL = ${JSON.stringify(url)};</script>` : "",
  body,
].join("\n");
fs.writeFileSync(process.argv[2], out);
console.log("wrote", process.argv[2], out.length, "bytes");
