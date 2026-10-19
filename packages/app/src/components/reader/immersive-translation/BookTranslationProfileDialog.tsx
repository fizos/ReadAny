import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import type { BookProfileDraft, BookTranslationProfile, BookGlossaryEntry } from "@readany/core/translation/book-context";
import { TRANSLATOR_LANGS } from "@readany/core/types/translation";
import { useEffect, useRef, useState } from "react";

export function parseBookGlossary(value: string, previous: BookGlossaryEntry[]): BookGlossaryEntry[] {
  const seen = new Set<string>();
  const rows = value.split(/\r?\n/).filter((line) => line.trim());
  if (rows.length > 100) throw new Error("术语表最多保存 100 项。");
  return rows.map((line, index) => {
    const separator = line.indexOf("=");
    const source = line.slice(0, separator).trim();
    const target = line.slice(separator + 1).trim();
    if (separator < 1 || !target) throw new Error(`术语第 ${index + 1} 行请使用“原词 = 译词”。`);
    if (source.length > 100 || target.length > 200) throw new Error(`术语第 ${index + 1} 行过长。`);
    const identity = source.toLowerCase();
    if (seen.has(identity)) throw new Error(`术语重复：${source}`);
    seen.add(identity);
    const old = previous.find((entry) => entry.source === source && entry.target === target);
    return { source, target, origin: old?.origin ?? "manual" };
  });
}

function draftFrom(profile: BookTranslationProfile | null | undefined, title: string): BookProfileDraft {
  return profile ? { ...profile } : { enabled: true, title: title.slice(0, 300), domain: "", summary: "", style: "", glossary: [] };
}

export function BookTranslationProfileDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  targetLang: string;
  profile?: BookTranslationProfile | null;
  status?: string;
  error?: string;
  onSave: (lang: string, draft: BookProfileDraft) => Promise<BookTranslationProfile>;
  onRegenerate: (lang: string, signal: AbortSignal) => Promise<BookTranslationProfile | null>;
  onCancelGeneration: () => void;
}) {
  const [draft, setDraft] = useState(() => draftFrom(props.profile, props.title));
  const [glossary, setGlossary] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"save" | "analyze" | null>(null);
  const [dirty, setDirty] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const latestOpen = useRef(props.open);
  latestOpen.current = props.open;
  const setFrom = (profile: BookTranslationProfile | null | undefined) => {
    const next = draftFrom(profile, props.title);
    setDraft(next);
    setGlossary(next.glossary.map((term) => `${term.source} = ${term.target}`).join("\n"));
    setDirty(false);
  };
  useEffect(() => {
    if (!props.open) return;
    setFrom(props.profile);
    setError("");
  }, [props.open, props.targetLang]);
  useEffect(() => {
    if (props.open && !dirty && !busy) setFrom(props.profile);
  }, [props.profile]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const save = async () => {
    try {
      const terms = parseBookGlossary(glossary, draft.glossary);
      setBusy("save"); setError("");
      await props.onSave(props.targetLang, { ...draft, glossary: terms });
      setDirty(false);
      props.onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "档案保存失败，请重试。");
    } finally { setBusy(null); }
  };
  const analyze = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy("analyze"); setError("");
    try {
      const profile = await props.onRegenerate(props.targetLang, controller.signal);
      if (!controller.signal.aborted && latestOpen.current) setFrom(profile);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "分析失败，请重试。");
    } finally {
      if (abortRef.current === controller) { abortRef.current = null; setBusy(null); }
    }
  };
  const change = (field: "title" | "domain" | "summary" | "style", value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value })); setDirty(true);
  };
  const generating = busy === "analyze" || props.status === "generating";
  return <Dialog open={props.open} onOpenChange={(open) => {
    if (busy === "save") return;
    if (!open) abortRef.current?.abort();
    props.onOpenChange(open);
  }}>
    <DialogContent layout="form" busy={busy === "save"}>
      <DialogHeader>
        <DialogTitle>本书翻译档案</DialogTitle>
        <DialogDescription>{props.title} · {TRANSLATOR_LANGS[props.targetLang as keyof typeof TRANSLATOR_LANGS] || props.targetLang}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="space-y-4 text-sm">
          <label className="flex items-center justify-between gap-3">
            <span>启用本书上下文增强（AI 翻译）</span>
            <Switch checked={draft.enabled} disabled={Boolean(busy)} onCheckedChange={(enabled) => { setDraft((old) => ({ ...old, enabled })); setDirty(true); }} />
          </label>
          <p className="text-xs text-muted-foreground">首次分析将书名、目录和少量当前页原文发送给已配置的翻译模型。档案仅在本机保存；DeepL 和微软翻译不使用此档案。</p>
          {props.status === "loading" && <p role="status">正在读取本书档案…</p>}
          {generating && <p role="status">正在分析书籍主题和术语，翻页不会重新分析…</p>}
          <label className="block space-y-1"><span>书名</span><Input value={draft.title} maxLength={300} disabled={Boolean(busy)} onChange={(event) => change("title", event.target.value)} /></label>
          <label className="block space-y-1"><span>专业领域</span><Input value={draft.domain} maxLength={300} disabled={Boolean(busy)} placeholder="例如：大语言模型推理与部署" onChange={(event) => change("domain", event.target.value)} /></label>
          <label className="block space-y-1"><span>书籍背景</span><Textarea value={draft.summary} maxLength={2000} rows={3} disabled={Boolean(busy)} onChange={(event) => change("summary", event.target.value)} /></label>
          <label className="block space-y-1"><span>译文风格与约定</span><Textarea value={draft.style} maxLength={1000} rows={2} disabled={Boolean(busy)} placeholder="例如：使用技术书籍语气，保留 API 名称和代码。" onChange={(event) => change("style", event.target.value)} /></label>
          <label className="block space-y-1"><span>术语表（每行：原词 = 译词）</span><Textarea value={glossary} rows={5} disabled={Boolean(busy)} onChange={(event) => { setGlossary(event.target.value); setDirty(true); }} /></label>
          <p className="text-xs text-muted-foreground">手动修改的术语优先于自动分析。保存后会重新翻译当前页，不复用旧档案的译文缓存。</p>
          {dirty && <p className="text-xs text-muted-foreground">有未保存修改；重新分析前请先保存。</p>}
          {(error || props.error) && <p role="alert" className="text-sm text-destructive">{error || props.error}</p>}
          {generating ? <Button variant="outline" size="sm" onClick={() => { abortRef.current?.abort(); props.onCancelGeneration(); }}>取消书籍分析</Button> :
            <Button variant="outline" size="sm" disabled={Boolean(busy) || dirty || props.status === "loading"} onClick={() => void analyze()}>重新分析本书</Button>}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" disabled={busy === "save"} onClick={() => props.onOpenChange(false)}>取消</Button>
        <Button disabled={Boolean(busy) || props.status === "loading"} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存档案"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
