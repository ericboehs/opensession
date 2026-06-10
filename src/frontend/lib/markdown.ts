import { Marked } from "marked";

// Dedicated marked instance for session messages so this config doesn't leak
// into other markdown (wiki, etc.). Two customisations:
//  - every link opens in a new tab (target=_blank + safe rel)
//  - images render inline, capped in size, and click through to the full image
const md = new Marked({ async: false, breaks: true });

function attr(v: string | null | undefined): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

md.use({
  renderer: {
    link(token: any) {
      const text = this.parser.parseInline(token.tokens);
      const title = token.title ? ` title="${attr(token.title)}"` : "";
      return `<a href="${attr(token.href)}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image(token: any) {
      const title = token.title ? ` title="${attr(token.title)}"` : "";
      return (
        `<a href="${attr(token.href)}" target="_blank" rel="noopener noreferrer" class="md-image-link">` +
        `<img class="md-image" src="${attr(token.href)}" alt="${attr(token.text)}"${title} loading="lazy" />` +
        `</a>`
      );
    },
  },
});

/** Render session markdown to HTML (links open in a new tab, images inline). */
export function renderMarkdown(src: string): string {
  try {
    return md.parse(src) as string;
  } catch {
    return src;
  }
}
