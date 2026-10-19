/**
 * DOM-side primitives used by the high-fidelity EPUB translator.
 *
 * The important safety property here is that model output is only ever copied
 * into existing Text nodes.  No model-provided string is parsed as HTML.
 */

const EPubIdAttribute = "data-readany-epub-id";
const HiddenMarkerAttribute = "data-readany-epub-hidden";
const HTMLNamespace = "http://www.w3.org/1999/xhtml";
const XMLNamespace = "http://www.w3.org/XML/1998/namespace";
const ProtectedTags = new Set([
  "pre",
  "code",
  "kbd",
  "samp",
  "math",
  "svg",
  "script",
  "style",
  "noscript",
]);
const ExcludedTags = new Set([...ProtectedTags, "rt", "rp"]);
const StandardBlockTags = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "dd",
  "dt",
  "figcaption",
  "td",
  "th",
  "caption",
]);
const TokenMarkerPattern = /\[\[\/?(?:R|K)\d+\]\]/;

export interface EpubFidelityRun {
  node: Text;
  text: string;
}

export interface EpubFidelityBlock {
  id: string;
  element: Element;
  runs: EpubFidelityRun[];
  text: string;
  requestText: string;
}

type FidelityToken =
  | { kind: "R"; index: number; value: string; node: Text }
  | { kind: "K"; index: number; value: string };

interface EpubFidelityMetadata {
  tokens: FidelityToken[];
  sourceRuns: EpubFidelityRun[];
}

const metadataByBlock = new WeakMap<EpubFidelityBlock, EpubFidelityMetadata>();

function localName(element: Element): string {
  return (element.localName || element.tagName || "").toLowerCase();
}

function ancestors(element: Element | null): Element[] {
  const result: Element[] = [];
  let current = element;
  while (current) {
    result.push(current);
    current = current.parentElement;
  }
  return result;
}

function hasHiddenInlineStyle(element: Element): boolean {
  const style = element.getAttribute("style");
  if (!style) return false;
  return /(?:^|;)\s*(?:display|visibility|content-visibility)\s*:\s*(?:none|hidden)\s*(?:!important)?\s*(?:;|$)/i.test(
    style,
  );
}

function isHidden(element: Element): boolean {
  for (const current of ancestors(element)) {
    if (current.getAttribute(HiddenMarkerAttribute) === "true") return true;
    if (current.hasAttribute("hidden")) return true;
    if (current.getAttribute("aria-hidden")?.trim().toLowerCase() === "true") return true;
    if (hasHiddenInlineStyle(current)) return true;

    // Parsed EPUB documents normally have no live window, while browser-loaded
    // chapter documents do.  Use computed style when it is safely available,
    // without making DOM collection depend on a browser-only global.
    const view = current.ownerDocument.defaultView;
    if (view) {
      try {
        const computed = view.getComputedStyle(current);
        if (computed.display === "none" || computed.visibility === "hidden") return true;
      } catch {
        // Some XML documents expose a window but do not support CSS inspection.
      }
    }
  }
  return false;
}

function hasNoterefToken(value: string | null): boolean {
  if (!value) return false;
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .some(
      (token) => token === "noteref" || token === "doc-noteref" || token.includes("footnote-ref"),
    );
}

function hasNoterefAttribute(element: Element): boolean {
  return (
    hasNoterefToken(element.getAttribute("epub:type")) ||
    hasNoterefToken(element.getAttributeNS("http://www.idpf.org/2007/ops", "type")) ||
    hasNoterefToken(element.getAttribute("role")) ||
    /(?:^|[\s_-])(?:footnote|note)[\s_-]*(?:ref|reference|noteref)(?:$|[\s_-])/i.test(
      element.getAttribute("class") || "",
    )
  );
}

function isFootnoteReference(element: Element): boolean {
  const path = ancestors(element);
  if (path.some(hasNoterefAttribute)) return true;
  const superscriptIndex = path.findIndex((current) => localName(current) === "sup");
  if (superscriptIndex < 0) return false;

  for (const current of path.slice(superscriptIndex)) {
    if (hasNoterefAttribute(current)) return true;
    if (localName(current) === "a" && (current.getAttribute("href") || "").startsWith("#"))
      return true;
  }
  return false;
}

function isExcludedTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return true;
  for (const current of ancestors(parent)) {
    if (ExcludedTags.has(localName(current))) return true;
  }
  return isFootnoteReference(parent);
}

function protectedAncestor(node: Text): Element | null {
  let current: Element | null = node.parentElement;
  while (current) {
    if (ProtectedTags.has(localName(current))) return current;
    current = current.parentElement;
  }
  return null;
}

function isEligibleTextNode(node: Text): boolean {
  if (!node.nodeValue || !node.parentElement) return false;
  return !isHidden(node.parentElement) && !isExcludedTextNode(node);
}

function isVisibleProtectedTextNode(node: Text): boolean {
  if (
    !node.nodeValue ||
    !node.parentElement ||
    isHidden(node.parentElement) ||
    isFootnoteReference(node.parentElement)
  ) {
    return false;
  }
  let current: Element | null = node.parentElement;
  while (current) {
    const tag = localName(current);
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "rt" || tag === "rp")
      return false;
    current = current.parentElement;
  }
  return true;
}

function isStandardBlock(element: Element): boolean {
  const tag = localName(element);
  if (StandardBlockTags.has(tag)) return true;
  if (tag === "a")
    return ancestors(element.parentElement).some((parent) => localName(parent) === "nav");
  if (tag === "text") {
    return ancestors(element.parentElement).some((parent) => localName(parent) === "navlabel");
  }
  if (tag === "navlabel") {
    return !Array.from(element.children).some((child) => localName(child) === "text");
  }
  return false;
}

function collectElements(doc: Document): Element[] {
  const allElements = Array.from(doc.querySelectorAll("*"));
  const standard = allElements.filter(isStandardBlock);
  const standardSet = new Set(standard);
  const fallback = allElements.filter((element) => {
    const tag = localName(element);
    // Container fallbacks also own inline-only prose, e.g. <div><span>text</span></div>.
    if (
      ![
        "body",
        "div",
        "section",
        "article",
        "header",
        "footer",
        "aside",
        "main",
        "figure",
        "nav",
      ].includes(tag)
    )
      return false;
    let current = element.parentElement;
    while (current) {
      if (standardSet.has(current)) return false;
      current = current.parentElement;
    }
    return true;
  });

  const result = [...standard, ...fallback];
  result.sort((left, right) => {
    if (left === right) return 0;
    const position = left.compareDocumentPosition(right);
    if (position & 2) return 1; // DOCUMENT_POSITION_PRECEDING
    if (position & 4) return -1; // DOCUMENT_POSITION_FOLLOWING
    return 0;
  });
  return result;
}

function ownerForNode(
  node: Node,
  candidateByElement: Map<Element, EpubFidelityBlock>,
): EpubFidelityBlock | null {
  let current: Element | null =
    node.nodeType === node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (current) {
    const owner = candidateByElement.get(current);
    if (owner) return owner;
    current = current.parentElement;
  }
  return null;
}

function visibleProtectedText(root: Element): string {
  let result = "";
  const walk = (node: Node): void => {
    if (node.nodeType === node.TEXT_NODE) {
      const text = node as Text;
      if (isVisibleProtectedTextNode(text)) result += text.nodeValue || "";
      return;
    }
    if (node.nodeType !== node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element !== root && isHidden(element)) return;
    const tag = localName(element);
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "rt" || tag === "rp")
      return;
    for (const child of Array.from(element.childNodes)) walk(child);
  };
  walk(root);
  return result;
}

function collectBlockContent(
  blockElement: Element,
  candidateByElement: Map<Element, EpubFidelityBlock>,
): { tokens: FidelityToken[]; runs: EpubFidelityRun[] } {
  const tokens: FidelityToken[] = [];
  const runs: EpubFidelityRun[] = [];
  let runIndex = 0;
  let protectedIndex = 0;

  const walk = (node: Node): void => {
    if (node.nodeType === node.TEXT_NODE) {
      const textNode = node as Text;
      if (!isEligibleTextNode(textNode) || protectedAncestor(textNode)) return;
      if (ownerForNode(textNode, candidateByElement)?.element !== blockElement) return;
      const value = textNode.nodeValue || "";
      const run: EpubFidelityRun = { node: textNode, text: value };
      runs.push(run);
      tokens.push({ kind: "R", index: runIndex, value, node: textNode });
      runIndex += 1;
      return;
    }
    if (node.nodeType !== node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element !== blockElement && isHidden(element)) return;

    if (ProtectedTags.has(localName(element))) {
      if (ownerForNode(element, candidateByElement)?.element !== blockElement) return;
      const value = visibleProtectedText(element);
      if (value) {
        tokens.push({ kind: "K", index: protectedIndex, value });
        protectedIndex += 1;
      }
      return;
    }
    for (const child of Array.from(element.childNodes)) walk(child);
  };

  walk(blockElement);
  return { tokens, runs };
}

function hasMeaningfulToken(token: FidelityToken): boolean {
  return /\S/.test(token.value);
}

export function collectEpubBlocks(doc: Document): EpubFidelityBlock[] {
  const elements = collectElements(doc);
  const candidateByElement = new Map<Element, EpubFidelityBlock>();
  const provisional: Array<{
    element: Element;
    content: { tokens: FidelityToken[]; runs: EpubFidelityRun[] };
  }> = [];

  // Owners are installed before content collection so nested blocks can be
  // resolved to the closest eligible ancestor without duplicating text.
  for (const element of elements) {
    candidateByElement.set(element, {
      id: "",
      element,
      runs: [],
      text: "",
      requestText: "",
    });
  }

  for (const element of elements) {
    const content = collectBlockContent(element, candidateByElement);
    if (content.runs.length === 0 || !content.tokens.some(hasMeaningfulToken)) continue;
    provisional.push({ element, content });
  }

  const result: EpubFidelityBlock[] = [];
  const reservedIds = new Set(
    elements
      .map((element) => element.getAttribute(EPubIdAttribute) || "")
      .filter((id) => Boolean(id)),
  );
  const usedIds = new Set<string>();
  let generatedId = 0;
  for (const item of provisional) {
    let id = item.element.getAttribute(EPubIdAttribute) || "";
    if (!id || usedIds.has(id)) {
      do {
        id = `readany-epub-${generatedId}`;
        generatedId += 1;
      } while (usedIds.has(id) || reservedIds.has(id));
      item.element.setAttribute(EPubIdAttribute, id);
    }
    usedIds.add(id);

    const runs = item.content.runs;
    const text = item.content.tokens.map((token) => token.value).join("");
    const requestText = item.content.tokens
      .map(
        (token) => `[[${token.kind}${token.index}]]${token.value}[[/${token.kind}${token.index}]]`,
      )
      .join("");
    const block: EpubFidelityBlock = {
      id,
      element: item.element,
      runs,
      text,
      requestText,
    };
    metadataByBlock.set(block, {
      tokens: item.content.tokens,
      sourceRuns: runs.map((run) => ({ node: run.node, text: run.text })),
    });
    result.push(block);
  }
  return result;
}

function stripOptionalFence(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const match = /^```(?:[A-Za-z0-9_-]+)?\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return match ? match[1] : null;
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  return index;
}

function markerAt(value: string, start: number, token: FidelityToken, closing: boolean): boolean {
  const marker = `[[${closing ? "/" : ""}${token.kind}${token.index}]]`;
  return value.startsWith(marker, start);
}

export function parseEpubTranslation(block: EpubFidelityBlock, output: string): string[] | null {
  const metadata = metadataByBlock.get(block);
  if (!metadata || typeof output !== "string") return null;
  const source = stripOptionalFence(output);
  if (source === null) return null;

  const translations: string[] = [];
  let cursor = 0;
  for (const token of metadata.tokens) {
    cursor = skipWhitespace(source, cursor);
    if (!markerAt(source, cursor, token, false)) return null;
    cursor += `[[${token.kind}${token.index}]]`.length;

    if (token.kind === "K") {
      if (!source.startsWith(token.value, cursor)) return null;
      cursor += token.value.length;
      if (!markerAt(source, cursor, token, true)) return null;
      cursor += `[[/${token.kind}${token.index}]]`.length;
      continue;
    }

    const closingMarker = `[[/${token.kind}${token.index}]]`;
    const closing = source.indexOf(closingMarker, cursor);
    if (closing < 0) return null;
    const translation = source.slice(cursor, closing);
    if (TokenMarkerPattern.test(translation)) return null;
    if (/\S/.test(token.value)) {
      // A successful marker envelope must not be allowed to erase a source
      // run.  Whitespace-only source runs are handled separately below so
      // their exact boundaries remain structural rather than translatable.
      if (!translation.trim()) return null;
    } else if (translation !== token.value) {
      return null;
    }
    translations.push(translation);
    cursor = closing + closingMarker.length;
  }

  cursor = skipWhitespace(source, cursor);
  if (cursor !== source.length) return null;
  return translations;
}

export function applyEpubTranslation(block: EpubFidelityBlock, output: string): boolean {
  const metadata = metadataByBlock.get(block);
  const translations = parseEpubTranslation(block, output);
  if (!metadata || translations === null || translations.length !== metadata.sourceRuns.length)
    return false;
  for (let index = 0; index < metadata.sourceRuns.length; index += 1) {
    // This is intentionally the only write path for model output.
    const sourceText = metadata.sourceRuns[index].text;
    const translatedText = translations[index];
    if (!/\S/.test(sourceText)) {
      metadata.sourceRuns[index].node.nodeValue = sourceText;
      continue;
    }
    const leading = sourceText.match(/^\s*/)?.[0] || "";
    const trailing = sourceText.match(/\s*$/)?.[0] || "";
    const core = translatedText.trim();
    metadata.sourceRuns[index].node.nodeValue = `${leading}${core}${trailing}`;
  }
  return true;
}

function removePreviewArtifacts(doc: Document): void {
  const removeSelectors = [
    "script",
    "iframe",
    "object",
    "embed",
    ".readany-translation",
    "[data-readany-translation]",
    "[data-readany-translation-overlay]",
    "[data-readany-epub-overlay]",
    "[data-readany-epub-translation]",
    "[data-readany-translation-root]",
  ];
  for (const element of Array.from(doc.querySelectorAll(removeSelectors.join(","))))
    element.remove();

  const elements = doc.documentElement
    ? [doc.documentElement, ...Array.from(doc.querySelectorAll("*"))]
    : [];
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
    }
  }
}

function stripRootPaginatorStyle(element: Element): void {
  const style = element.getAttribute("style");
  if (!style) return;
  const declarations = style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .filter((declaration) => {
      const property = declaration.slice(0, declaration.indexOf(":")).trim().toLowerCase();
      return (
        !property.includes("column") &&
        !property.startsWith("transform") &&
        property !== "width" &&
        property !== "height" &&
        !property.startsWith("overflow")
      );
    });
  if (declarations.length) element.setAttribute("style", declarations.join("; "));
  else element.removeAttribute("style");
}

function createElement(doc: Document, name: string): Element {
  const namespace = doc.documentElement.namespaceURI;
  return namespace ? doc.createElementNS(namespace, name) : doc.createElement(name);
}

function addPreviewOverrides(doc: Document, head: Element): void {
  for (const old of Array.from(doc.querySelectorAll('style[data-readany-epub-preview="true"]')))
    old.remove();
  const style = createElement(doc, "style");
  style.setAttribute("data-readany-epub-preview", "true");
  style.textContent =
    "html, body { column-count: auto !important; column-width: auto !important; columns: auto !important; column-height: auto !important; width: auto !important; height: auto !important; min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important; overflow: visible !important; transform: none !important; transform-origin: initial !important; margin: 0 auto !important; }";
  head.appendChild(style);
}

export function cloneEpubForPreview(source: Document): Document {
  const clone = source.cloneNode(true) as Document;
  const sourceElements = Array.from(source.querySelectorAll("*"));
  const cloneElements = Array.from(clone.querySelectorAll("*"));
  for (let index = 0; index < sourceElements.length && index < cloneElements.length; index += 1) {
    if (isHidden(sourceElements[index]))
      cloneElements[index].setAttribute(HiddenMarkerAttribute, "true");
  }
  removePreviewArtifacts(clone);

  const html = clone.documentElement;
  const baseExists = Boolean(clone.querySelector("base[href]"));
  const sourceBase = source.baseURI;
  const head = clone.querySelector("head");
  if (html && !baseExists && sourceBase && head) {
    const base = createElement(clone, "base");
    base.setAttribute("href", sourceBase);
    head.insertBefore(base, head.firstChild);
  }

  if (html) stripRootPaginatorStyle(html);
  const body = clone.querySelector("body");
  if (body) stripRootPaginatorStyle(body);
  if (head) addPreviewOverrides(clone, head);
  return clone;
}

export function serializeEpubPreview(doc: Document, targetLang: string): string {
  removePreviewArtifacts(doc);
  for (const element of Array.from(doc.querySelectorAll(`[${HiddenMarkerAttribute}]`))) {
    element.removeAttribute(HiddenMarkerAttribute);
  }
  const root = doc.documentElement;
  if (!root) return "";
  root.setAttribute("lang", targetLang);
  if (root.namespaceURI === HTMLNamespace || root.getAttribute("xmlns") === HTMLNamespace) {
    root.setAttributeNS(XMLNamespace, "xml:lang", targetLang);
  }

  if (root.namespaceURI === HTMLNamespace || root.namespaceURI === null) {
    return root.outerHTML;
  }
  const serializer = new XMLSerializer();
  return serializer.serializeToString(doc);
}
