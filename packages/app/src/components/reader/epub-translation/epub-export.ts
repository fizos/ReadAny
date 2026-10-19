import {
  BlobReader,
  BlobWriter,
  type Entry,
  type FileEntry,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
  type ZipWriterAddDataOptions,
} from "@zip.js/zip.js";

const ContainerPath = "META-INF/container.xml";
const DublinCoreNamespace = "http://purl.org/dc/elements/1.1/";
const PackageNamespace = "http://www.idpf.org/2007/opf";
const XHTMLNamespace = "http://www.w3.org/1999/xhtml";
const XMLNamespace = "http://www.w3.org/XML/1998/namespace";
const HiddenMarkerAttribute = "data-readany-epub-hidden";

export interface EpubExportOptions {
  source: Blob;
  targetLang: string;
  signal: AbortSignal;
  translateDocument: (doc: Document, sectionKey: string) => Promise<void>;
  onProgress?: (current: number, total: number, label: string) => void;
}

interface ManifestItem {
  id: string;
  path: string;
  mediaType: string;
  properties: string;
  entry: FileEntry;
}

interface Section {
  path: string;
  item: ManifestItem;
}

function abortIfNeeded(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The EPUB export was aborted", "AbortError");
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function localName(element: Element): string {
  return (element.localName || element.tagName || "").toLowerCase();
}

function allElements(doc: Document): Element[] {
  return Array.from(doc.getElementsByTagName("*"));
}

function firstElement(doc: Document, name: string): Element | null {
  return allElements(doc).find((element) => localName(element) === name) || null;
}

function parseXml(value: string, mimeType: DOMParserSupportedType, label: string): Document {
  if (typeof DOMParser === "undefined")
    throw new Error(`Cannot parse ${label}: DOMParser is unavailable`);
  const doc = new DOMParser().parseFromString(value, mimeType);
  const parserError = allElements(doc).some((element) => localName(element) === "parsererror");
  if (parserError || !doc.documentElement) throw new Error(`Cannot parse EPUB XML: ${label}`);
  return doc;
}

function serializeDocument(doc: Document): string {
  const root = doc.documentElement;
  if (!root) throw new Error("Cannot serialize an EPUB document without a root element");
  if (
    root.namespaceURI === null ||
    (root.namespaceURI === "http://www.w3.org/1999/xhtml" && typeof XMLSerializer === "undefined")
  ) {
    return root.outerHTML;
  }
  if (typeof XMLSerializer === "undefined")
    throw new Error("Cannot serialize EPUB XML: XMLSerializer is unavailable");
  return new XMLSerializer().serializeToString(doc);
}

function setDocumentLanguage(doc: Document, targetLang: string): void {
  const root = doc.documentElement;
  if (!root || localName(root) !== "html") return;
  root.setAttribute("lang", targetLang);
  if (root.namespaceURI === XHTMLNamespace)
    root.setAttributeNS(XMLNamespace, "xml:lang", targetLang);
}

function stripRuntimeIds(doc: Document): void {
  for (const element of Array.from(doc.querySelectorAll("[data-readany-epub-id]"))) {
    element.removeAttribute("data-readany-epub-id");
  }
  for (const element of Array.from(doc.querySelectorAll(`[${HiddenMarkerAttribute}]`))) {
    element.removeAttribute(HiddenMarkerAttribute);
  }
}

function markHiddenCssRules(doc: Document, css: string): void {
  const rules = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(rules)) {
    const selectors = match[1].trim();
    const declarations = match[2];
    if (
      selectors.startsWith("@") ||
      !/(?:^|;)\s*(?:display|visibility)\s*:\s*(?:none|hidden)\b/i.test(declarations)
    ) {
      continue;
    }
    for (const selector of selectors.split(",")) {
      try {
        for (const element of Array.from(doc.querySelectorAll(selector.trim()))) {
          element.setAttribute(HiddenMarkerAttribute, "true");
        }
      } catch {
        // Unsupported selectors (for example pseudo-elements) do not make the
        // rest of a chapter untranslatable.
      }
    }
  }
}

async function markDetachedDocumentHidden(
  doc: Document,
  sectionPath: string,
  entries: Map<string, FileEntry>,
  signal: AbortSignal,
): Promise<void> {
  const stylesheets: string[] = [];
  for (const style of allElements(doc).filter((element) => localName(element) === "style")) {
    if (style.textContent) stylesheets.push(style.textContent);
  }
  for (const link of allElements(doc).filter((element) => localName(element) === "link")) {
    const rel = (link.getAttribute("rel") || "").split(/\s+/).map((value) => value.toLowerCase());
    const href = link.getAttribute("href");
    if (!href || !rel.includes("stylesheet")) continue;
    let cssPath: string;
    try {
      cssPath = resolveArchivePath(sectionPath, href, `stylesheet for ${sectionPath}`);
    } catch {
      continue;
    }
    const cssEntry = lookupEntry(entries, cssPath);
    if (!cssEntry || cssEntry.encrypted) continue;
    stylesheets.push(decodeUtf8(await readEntry(cssEntry, signal)));
  }
  for (const css of stylesheets) markHiddenCssRules(doc, css);
}

function decodeArchivePath(value: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`Invalid percent-encoded EPUB path in ${label}`);
  }
  if (decoded.includes("\\") || decoded.startsWith("/")) {
    if (decoded.startsWith("/")) decoded = decoded.slice(1);
    else throw new Error(`Invalid EPUB path in ${label}`);
  }

  const segments: string[] = [];
  for (const segment of decoded.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) throw new Error(`EPUB path escapes the archive in ${label}`);
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  if (!segments.length) throw new Error(`Empty EPUB path in ${label}`);
  return segments.join("/");
}

function resolveArchivePath(basePath: string, href: string, label: string): string {
  const withoutFragment = href.split("#", 1)[0].split("?", 1)[0];
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(withoutFragment)) {
    throw new Error(`External URI is not allowed in EPUB path ${label}`);
  }
  if (withoutFragment.startsWith("/")) return decodeArchivePath(withoutFragment, label);
  const directory = basePath.includes("/")
    ? `${basePath.slice(0, basePath.lastIndexOf("/") + 1)}`
    : "";
  return decodeArchivePath(`${directory}${withoutFragment}`, label);
}

function lookupEntry(entries: Map<string, FileEntry>, path: string): FileEntry | null {
  const exact = entries.get(path);
  if (exact) return exact;
  // URI references may encode spaces while ZIP names contain literal spaces.
  try {
    const encoded = encodeURI(path);
    return entries.get(encoded) || null;
  } catch {
    return null;
  }
}

async function readEntry(
  entry: FileEntry,
  signal: AbortSignal,
  passThrough = false,
): Promise<Uint8Array> {
  abortIfNeeded(signal);
  const writer = new Uint8ArrayWriter();
  const bytes = await entry.getData(writer, { signal, passThrough });
  abortIfNeeded(signal);
  return new Uint8Array(bytes);
}

function validateArchiveEntryNames(entries: Entry[]): void {
  for (const entry of entries) {
    if (!entry.filename) throw new Error("EPUB contains an empty ZIP entry name");
    if (entry.filename.startsWith("/"))
      throw new Error(`EPUB entry uses an absolute path: ${entry.filename}`);
    if (entry.filename.includes("\\"))
      throw new Error(`EPUB entry uses an unsafe path: ${entry.filename}`);
    const segments: string[] = [];
    for (const segment of entry.filename.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (!segments.length) throw new Error(`EPUB entry escapes the archive: ${entry.filename}`);
        segments.pop();
      } else segments.push(segment);
    }
  }
}

function preserveEntryOptions(
  entry: Entry,
  signal: AbortSignal,
  passThrough: boolean,
): ZipWriterAddDataOptions {
  const options: ZipWriterAddDataOptions & {
    compressionMethod?: number;
    encrypted?: boolean;
  } = {
    directory: entry.directory,
    comment: entry.comment,
    executable: entry.executable,
    externalFileAttributes: entry.externalFileAttributes,
    internalFileAttributes: entry.internalFileAttributes,
    lastModDate: entry.lastModDate,
    lastAccessDate: entry.lastAccessDate,
    creationDate: entry.creationDate,
    version: entry.version,
    versionMadeBy: entry.versionMadeBy,
    unixMode: entry.unixMode,
    uid: entry.uid,
    gid: entry.gid,
    setuid: entry.setuid,
    setgid: entry.setgid,
    sticky: entry.sticky,
    msDosCompatible: entry.msDosCompatible,
    msdosAttributesRaw: entry.msdosAttributesRaw,
    signal,
    extendedTimestamp: true,
  };

  if (entry.extraField) {
    const extraField = new Map<number, Uint8Array>();
    entry.extraField.forEach((value, key) => extraField.set(key, value.data));
    options.extraField = extraField;
  }
  if (passThrough) {
    options.passThrough = true;
    options.uncompressedSize = entry.uncompressedSize;
    options.signature = entry.signature;
    options.compressionMethod = entry.compressionMethod;
    options.encrypted = entry.encrypted;
  }
  return options;
}

function itemIsXhtml(item: ManifestItem): boolean {
  return (
    item.mediaType === "application/xhtml+xml" ||
    item.mediaType === "text/html" ||
    /\.(?:xhtml?|html?)$/i.test(item.path)
  );
}

function addSection(sections: Section[], seen: Set<string>, item: ManifestItem | undefined): void {
  if (!item || !itemIsXhtml(item) || seen.has(item.path)) return;
  seen.add(item.path);
  sections.push({ path: item.path, item });
}

function updateOpfLanguage(doc: Document, targetLang: string): void {
  const packageElement = firstElement(doc, "package");
  if (!packageElement) throw new Error("EPUB package document has no package element");
  let metadata =
    Array.from(packageElement.children).find((child) => localName(child) === "metadata") || null;
  if (!metadata) {
    const namespace = packageElement.namespaceURI || PackageNamespace;
    metadata = doc.createElementNS(namespace, "metadata");
    packageElement.appendChild(metadata);
  }

  const languageElements = allElements(metadata.ownerDocument).filter(
    (element) =>
      localName(element) === "language" &&
      (element.namespaceURI === DublinCoreNamespace ||
        element.prefix === "dc" ||
        element.parentElement === metadata),
  );
  if (languageElements.length) {
    for (const language of languageElements) language.textContent = targetLang;
    return;
  }

  const prefix = packageElement.lookupPrefix?.(DublinCoreNamespace) || "dc";
  if (!packageElement.lookupNamespaceURI?.(prefix)) {
    packageElement.setAttribute(`xmlns:${prefix}`, DublinCoreNamespace);
  }
  const language = doc.createElementNS(DublinCoreNamespace, `${prefix}:language`);
  language.textContent = targetLang;
  metadata.appendChild(language);
}

async function loadManifestAndSections(
  opfEntry: FileEntry,
  opfPath: string,
  entriesByPath: Map<string, FileEntry>,
  signal: AbortSignal,
): Promise<{ opf: Document; sections: Section[]; ncxSections: Section[] }> {
  const opfBytes = await readEntry(opfEntry, signal);
  const opf = parseXml(decodeUtf8(opfBytes), "application/xml", opfPath);
  const manifest = firstElement(opf, "manifest");
  const spine = firstElement(opf, "spine");
  if (!manifest || !spine) throw new Error("EPUB package document is missing manifest or spine");

  const byId = new Map<string, ManifestItem>();
  const itemElements = Array.from(manifest.children).filter(
    (element) => localName(element) === "item",
  );
  for (const itemElement of itemElements) {
    const id = itemElement.getAttribute("id");
    const href = itemElement.getAttribute("href");
    const mediaType = itemElement.getAttribute("media-type") || "";
    if (!id || !href) continue;
    const path = resolveArchivePath(opfPath, href, `manifest item ${id}`);
    const entry = lookupEntry(entriesByPath, path);
    if (!entry) throw new Error(`EPUB manifest item is missing from the archive: ${path}`);
    byId.set(id, {
      id,
      // Keep section keys in the normalized URI form used by the reader;
      // entry.filename remains the exact ZIP name for the write-back map.
      path,
      mediaType,
      properties: itemElement.getAttribute("properties") || "",
      entry,
    });
  }

  const sections: Section[] = [];
  const seen = new Set<string>();
  for (const itemref of Array.from(spine.children).filter(
    (element) => localName(element) === "itemref",
  )) {
    addSection(sections, seen, byId.get(itemref.getAttribute("idref") || ""));
  }

  const navSections = Array.from(byId.values()).filter((item) =>
    item.properties.split(/\s+/).includes("nav"),
  );
  for (const item of navSections) addSection(sections, seen, item);
  // Non-spine XHTML may contain linked footnotes, appendices or glossary pages.
  for (const item of byId.values()) addSection(sections, seen, item);

  const ncxSections: Section[] = [];
  for (const item of byId.values()) {
    if (item.mediaType === "application/x-dtbncx+xml" || /\.ncx$/i.test(item.path)) {
      if (!seen.has(item.path)) {
        seen.add(item.path);
        ncxSections.push({ path: item.path, item });
      }
    }
  }
  return { opf, sections, ncxSections };
}

export async function exportEpubTranslation(options: EpubExportOptions): Promise<Blob> {
  const { source, targetLang, signal, translateDocument, onProgress } = options;
  abortIfNeeded(signal);

  const reader = new ZipReader(new BlobReader(source), { signal });
  let writer: ZipWriter<Blob> | null = null;
  let writerClosed = false;
  try {
    const entries = await reader.getEntries({});
    validateArchiveEntryNames(entries);
    const mimetypeEntry = entries.find(
      (entry): entry is FileEntry => !entry.directory && entry.filename === "mimetype",
    );
    if (!mimetypeEntry) throw new Error("EPUB mimetype entry is missing");
    if (mimetypeEntry.encrypted)
      throw new Error("EPUB mimetype is encrypted and cannot be validated");
    const mimetypeBytes = await readEntry(mimetypeEntry, signal);
    const mimetype = decodeUtf8(mimetypeBytes);
    if (mimetype !== "application/epub+zip") throw new Error("EPUB mimetype entry is invalid");

    const fileEntries = new Map<string, FileEntry>();
    for (const entry of entries) if (!entry.directory) fileEntries.set(entry.filename, entry);
    const containerEntry = lookupEntry(fileEntries, ContainerPath);
    if (!containerEntry || containerEntry.encrypted)
      throw new Error("EPUB container.xml is missing or encrypted");
    const container = parseXml(
      decodeUtf8(await readEntry(containerEntry, signal)),
      "application/xml",
      ContainerPath,
    );
    const rootfile = allElements(container).find((element) => localName(element) === "rootfile");
    const rootfilePath = rootfile?.getAttribute("full-path");
    if (!rootfilePath) throw new Error("EPUB container.xml has no rootfile full-path");
    // The container rootfile full-path is rooted at the archive, unlike an
    // OPF manifest href, which is relative to the OPF directory.
    const opfPath = decodeArchivePath(rootfilePath, "container rootfile");
    const opfEntry = lookupEntry(fileEntries, opfPath);
    if (!opfEntry || opfEntry.encrypted)
      throw new Error("EPUB package document is missing or encrypted");

    const packageData = await loadManifestAndSections(opfEntry, opfPath, fileEntries, signal);
    const sections = [...packageData.sections, ...packageData.ncxSections];
    const changed = new Map<string, Uint8Array>();
    updateOpfLanguage(packageData.opf, targetLang);
    changed.set(opfEntry.filename, encodeUtf8(serializeDocument(packageData.opf)));

    let current = 0;
    for (const section of sections) {
      abortIfNeeded(signal);
      if (section.item.entry.encrypted) {
        throw new Error(`EPUB section is encrypted and cannot be translated: ${section.path}`);
      }
      const mediaType =
        section.item.mediaType === "text/html"
          ? "text/html"
          : section.item.mediaType === "application/x-dtbncx+xml"
            ? "application/xml"
            : "application/xhtml+xml";
      const document = parseXml(
        decodeUtf8(await readEntry(section.item.entry, signal)),
        mediaType,
        section.path,
      );
      await markDetachedDocumentHidden(document, section.path, fileEntries, signal);
      await translateDocument(document, section.path);
      abortIfNeeded(signal);
      stripRuntimeIds(document);
      setDocumentLanguage(document, targetLang);
      // Export keeps the chapter's original XHTML structure, CSS links, SVG,
      // MathML, scripts, and resource references.  Preview-only sanitization
      // belongs to cloneEpubForPreview/serializeEpubPreview.
      changed.set(section.item.entry.filename, encodeUtf8(serializeDocument(document)));
      current += 1;
      onProgress?.(current, sections.length, section.path);
    }

    const outputWriter = new BlobWriter("application/epub+zip");
    writer = new ZipWriter(outputWriter, { signal, keepOrder: true, bufferedWrite: true });
    const orderedEntries = [mimetypeEntry, ...entries.filter((entry) => entry !== mimetypeEntry)];
    for (const entry of orderedEntries) {
      abortIfNeeded(signal);
      if (entry.directory) {
        await writer.add(entry.filename, undefined, preserveEntryOptions(entry, signal, false));
        continue;
      }
      if (entry === mimetypeEntry) {
        const addOptions = preserveEntryOptions(entry, signal, false);
        addOptions.level = 0;
        await writer.add(
          entry.filename,
          new Uint8ArrayReader(encodeUtf8("application/epub+zip")),
          addOptions,
        );
        continue;
      }
      const translated = changed.get(entry.filename);
      if (translated) {
        const addOptions = preserveEntryOptions(entry, signal, false);
        addOptions.level = entry.filename === "mimetype" ? 0 : 6;
        await writer.add(entry.filename, new Uint8ArrayReader(translated), addOptions);
      } else {
        const raw = await readEntry(entry, signal, true);
        await writer.add(
          entry.filename,
          new Uint8ArrayReader(raw),
          preserveEntryOptions(entry, signal, true),
        );
      }
    }
    const result = await writer.close(reader.comment);
    writerClosed = true;
    return result;
  } catch (error) {
    if (writer && !writerClosed) {
      try {
        await writer.close();
      } catch {
        // Preserve the original export/abort error.
      }
    }
    throw error;
  } finally {
    await reader.close();
  }
}
