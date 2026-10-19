/** Toolbar menu for the PDF high-fidelity translation workflow. */
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSettingsStore } from "@/stores/settings-store";
import type { TranslationTargetLang } from "@readany/core/types/translation";
import { TRANSLATOR_LANGS } from "@readany/core/types/translation";
import { Languages, RefreshCw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { EpubTranslationState } from "./epub-translation/useEpubTranslation";
import type { HighFidelityPdfState } from "./immersive-translation/high-fidelity-pdf";

interface ChapterTranslationMenuProps {
  epubState?: EpubTranslationState;
  onEpubStart?: (targetLang?: string) => void;
  onEpubCancel?: () => void;
  onEpubRetry?: () => void;
  onEpubExit?: () => void;
  onBookProfile?: () => void;
  bookContextStatus?: string;
  highFidelityState?: HighFidelityPdfState;
  onHighFidelityStart?: (targetLang?: string) => void;
  onHighFidelityInstall?: () => void;
  onHighFidelityCancel?: () => void;
  onHighFidelityRetry?: () => void;
  onHighFidelityExit?: () => void;
}

export function ChapterTranslationMenu({
  epubState,
  onEpubStart,
  onEpubCancel,
  onEpubRetry,
  onEpubExit,
  onBookProfile,
  bookContextStatus,
  highFidelityState,
  onHighFidelityStart,
  onHighFidelityInstall,
  onHighFidelityCancel,
  onHighFidelityRetry,
  onHighFidelityExit,
}: ChapterTranslationMenuProps) {
  const { t } = useTranslation();
  const defaultLang = useSettingsStore((s) => s.translationConfig.targetLang);
  const setTranslationLang = useSettingsStore((s) => s.setTranslationLang);
  const [selectedLang, setSelectedLang] = useState<TranslationTargetLang>(defaultLang);
  const isActive = Boolean(highFidelityState?.enabled || epubState?.enabled);
  const isEpub = Boolean(epubState);
  const activeLang = highFidelityState?.enabled
    ? highFidelityState.targetLang
    : epubState?.enabled
      ? epubState.targetLang
      : selectedLang;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={`h-7 w-7 ${isActive ? "bg-primary/10 text-primary" : ""}`}
          title={isEpub ? "高保真 EPUB 翻译" : "高保真 PDF 翻译"}
        >
          <Languages className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        {onBookProfile && (
          <>
            <DropdownMenuItem
              onSelect={() => {
                setTranslationLang(activeLang as TranslationTargetLang);
                onBookProfile();
              }}
            >
              本书翻译档案
            </DropdownMenuItem>
            {bookContextStatus && (
              <output className="block px-2 py-1.5 text-xs text-muted-foreground">
                {bookContextStatus}
              </output>
            )}
            <DropdownMenuSeparator />
          </>
        )}

        {epubState ? (
          <>
            <div className="px-2 py-1.5 text-xs font-medium">高保真 EPUB 翻译</div>
            {!epubState.enabled ? (
              <>
                <div className="px-2 py-1.5">
                  <Select
                    value={selectedLang}
                    onValueChange={(value) => setSelectedLang(value as TranslationTargetLang)}
                  >
                    <SelectTrigger className="h-7 w-full text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(TRANSLATOR_LANGS).map(([code, name]) => (
                        <SelectItem key={code} value={code} className="text-xs">
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <DropdownMenuItem
                  className="gap-2 text-xs"
                  onSelect={() => {
                    setTranslationLang(selectedLang);
                    onEpubStart?.(selectedLang);
                  }}
                >
                  <Languages className="h-3.5 w-3.5" />
                  开始高保真 EPUB 翻译
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <output className="block px-2 py-1.5 text-xs text-muted-foreground">
                  {epubState.status === "extracting"
                    ? "读取当前页面"
                    : epubState.status === "processing"
                      ? `已翻译 ${epubState.completed} / ${epubState.requested} 段`
                      : epubState.status === "error"
                        ? epubState.error
                        : epubState.status === "cancelled"
                          ? "翻译已暂停"
                          : "当前可见内容已处理"}
                </output>
                {epubState.status === "processing" && (
                  <DropdownMenuItem onSelect={onEpubCancel}>
                    <X className="mr-2 h-3.5 w-3.5" />
                    暂停翻译
                  </DropdownMenuItem>
                )}
                {(epubState.status === "error" || epubState.status === "cancelled") && (
                  <DropdownMenuItem onSelect={onEpubRetry}>
                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                    重试当前内容
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onEpubExit}>
                  <X className="mr-2 h-3.5 w-3.5" />
                  退出 EPUB 翻译
                </DropdownMenuItem>
              </>
            )}
          </>
        ) : isActive && highFidelityState ? (
          <>
            <div className="px-2 py-1.5 text-xs font-medium">高保真 PDF 翻译</div>
            <div className="px-2 pb-1.5 text-[11px] text-muted-foreground">
              {highFidelityState.status === "needs-setup"
                ? "需要首次初始化本地引擎"
                : highFidelityState.status === "installing"
                  ? "正在初始化本地引擎"
                  : highFidelityState.status === "translating"
                    ? `翻译中：${highFidelityState.phase}`
                    : highFidelityState.status === "complete"
                      ? "当前页已完成"
                      : highFidelityState.status === "cancelled"
                        ? "已取消"
                        : "需要重试"}
            </div>
            {highFidelityState.status === "needs-setup" && onHighFidelityInstall && (
              <DropdownMenuItem className="gap-2 text-xs" onSelect={onHighFidelityInstall}>
                <Languages className="h-3.5 w-3.5" />
                初始化并翻译当前页
              </DropdownMenuItem>
            )}
            {(highFidelityState.status === "installing" ||
              highFidelityState.status === "translating") &&
              onHighFidelityCancel && (
                <DropdownMenuItem
                  className="gap-2 text-xs text-destructive"
                  onSelect={onHighFidelityCancel}
                >
                  <X className="h-3.5 w-3.5" />
                  取消
                </DropdownMenuItem>
              )}
            {(highFidelityState.status === "error" || highFidelityState.status === "cancelled") &&
              onHighFidelityRetry && (
                <DropdownMenuItem className="gap-2 text-xs" onSelect={onHighFidelityRetry}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("common.retry")}
                </DropdownMenuItem>
              )}
            <DropdownMenuSeparator />
            {onHighFidelityExit && (
              <DropdownMenuItem
                className="gap-2 text-xs text-destructive"
                onSelect={onHighFidelityExit}
              >
                <Trash2 className="h-3.5 w-3.5" />
                退出高保真翻译
              </DropdownMenuItem>
            )}
          </>
        ) : (
          <>
            <div className="px-2 py-1.5">
              <Select
                value={selectedLang}
                onValueChange={(value) => setSelectedLang(value as TranslationTargetLang)}
              >
                <SelectTrigger className="h-7 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TRANSLATOR_LANGS).map(([code, name]) => (
                    <SelectItem key={code} value={code} className="text-xs">
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {onHighFidelityStart && (
              <DropdownMenuItem
                className="gap-2 text-xs"
                onSelect={(event) => {
                  event.preventDefault();
                  setTranslationLang(selectedLang);
                  onHighFidelityStart(selectedLang);
                }}
              >
                <Languages className="h-3.5 w-3.5" />
                高保真 PDF 翻译
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
