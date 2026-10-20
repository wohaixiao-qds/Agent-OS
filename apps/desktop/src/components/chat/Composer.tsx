import { useEffect, useMemo, useRef, useState } from "react";
import type { BotConfig } from "@zy-aos/shared";
import { api, RUNTIME_BASE_URL } from "../../lib/api";
import { IconArrowUp, IconAt, IconChevronDown } from "../shell/icons";

type PendingImage = {
  id: string;
  file: File;
  preview: string;
};

type ComposerProps = {
  bots: BotConfig[];
  disabled?: boolean;
  sending?: boolean;
  onSend: (content: string, mentionBotId?: string) => void;
  onAbort: () => void;
};

export function Composer({
  bots,
  disabled,
  sending,
  onSend,
  onAbort,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [mentionBotId, setMentionBotId] = useState<string | undefined>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const footerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    return () => {
      for (const image of pendingImages) URL.revokeObjectURL(image.preview);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addImages(files: FileList | File[] | null) {
    const images = Array.from(files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (images.length === 0) return;
    setPendingImages((prev) => [
      ...prev,
      ...images.map((file, index) => ({
        id: `${Date.now()}-${index}-${file.name}`,
        file,
        preview: URL.createObjectURL(file),
      })),
    ]);
    textareaRef.current?.focus();
  }

  function removeImage(id: string) {
    setPendingImages((prev) => {
      const target = prev.find((image) => image.id === id);
      if (target) URL.revokeObjectURL(target.preview);
      return prev.filter((image) => image.id !== id);
    });
  }

  useEffect(() => {
    const footer = footerRef.current;
    const host = footer?.closest(".home-center");
    if (!footer || !(host instanceof HTMLElement)) return;
    const apply = () => {
      host.style.setProperty(
        "--composer-space",
        `${footer.offsetHeight + 20}px`,
      );
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(footer);
    return () => observer.disconnect();
  }, []);

  const mentioned = useMemo(
    () => bots.find((b) => b.id === mentionBotId),
    [bots, mentionBotId],
  );

  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    return bots.filter(
      (b) =>
        b.enabled &&
        (!q ||
          b.name.toLowerCase().includes(q) ||
          b.role.toLowerCase().includes(q)),
    );
  }, [bots, filter]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    const next = expanded ? Math.min(el.scrollHeight, 160) : Math.min(el.scrollHeight, 72);
    el.style.height = `${Math.max(next, 48)}px`;
  }, [text, expanded]);

  useEffect(() => {
    if (!mentionBotId) return;
    if (!bots.some((b) => b.id === mentionBotId && b.enabled)) {
      setMentionBotId(undefined);
    }
  }, [bots, mentionBotId]);

  function openPicker(fromAt = false) {
    setPickerOpen(true);
    setActiveIndex(0);
    setFilter(fromAt ? "" : filter);
    // Clicking the @ button leaves focus on the button; move it back so the
    // textarea keyboard handler drives the picker immediately.
    textareaRef.current?.focus();
  }

  function pickBot(bot: BotConfig) {
    setMentionBotId(bot.id);
    setPickerOpen(false);
    setFilter("");
    setText((prev) => {
      const withoutTrailingAt = prev.replace(/@[^\s@]*$/, "").trimEnd();
      return withoutTrailingAt ? `${withoutTrailingAt} ` : "";
    });
    textareaRef.current?.focus();
  }

  function handleChange(value: string) {
    setText(value);
    const atMatch = value.match(/@([^\s@]*)$/);
    if (atMatch) {
      setPickerOpen(true);
      setActiveIndex(0);
      setFilter(atMatch[1] ?? "");
    } else if (pickerOpen && !value.includes("@")) {
      setPickerOpen(false);
      setFilter("");
    }
  }

  async function handleSend() {
    const base = text.trim();
    if ((!base && pendingImages.length === 0) || disabled || sending || uploading) {
      return;
    }
    // 先把图片传到 runtime，消息里带上可渲染的 URL 和 agent 可读的本地路径
    let content = base;
    if (pendingImages.length > 0) {
      setUploading(true);
      try {
        for (const image of pendingImages) {
          const uploaded = await api.uploadAttachment(image.file);
          content += `\n\n![${image.file.name}](${RUNTIME_BASE_URL}${uploaded.url})\n（图片本地路径：${uploaded.path}，可用 Read 工具查看）`;
        }
      } catch (error) {
        setUploading(false);
        window.alert(
          error instanceof Error ? error.message : "图片上传失败，请重试",
        );
        return;
      }
      setUploading(false);
    }
    onSend(content, mentionBotId);
    for (const image of pendingImages) URL.revokeObjectURL(image.preview);
    setPendingImages([]);
    setText("");
    // Mentions are one-shot: clear after send so the chip does not linger.
    setMentionBotId(undefined);
    setPickerOpen(false);
    setFilter("");
  }

  return (
    <footer className="composer" ref={footerRef}>
      <div
        className={dragOver ? "composer-box is-dragover" : "composer-box"}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addImages(e.dataTransfer?.files ?? null);
        }}
      >
        {pendingImages.length > 0 ? (
          <div className="composer-images" aria-label="待发送图片">
            {pendingImages.map((image) => (
              <span key={image.id} className="composer-image-chip">
                <img src={image.preview} alt={image.file.name} />
                <button
                  type="button"
                  aria-label={`移除 ${image.file.name}`}
                  onClick={() => removeImage(image.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {mentioned ? (
          <div className="mention-chip-row">
            <span className="mention-chip">
              @{mentioned.name}
              <button
                type="button"
                className="chip-clear"
                aria-label="清除提及"
                onClick={() => setMentionBotId(undefined)}
              >
                ×
              </button>
            </span>
          </div>
        ) : null}

        {pickerOpen ? (
          <ul className="mention-picker" role="listbox" aria-label="提及智能体">
            {filtered.length === 0 ? (
              <li className="muted">暂无已启用的智能体</li>
            ) : (
              filtered.map((bot, index) => (
                <li
                  key={bot.id}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={index === activeIndex ? "active" : undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <button type="button" onClick={() => pickBot(bot)}>
                    <strong>@{bot.name}</strong>
                    <span className="muted">{bot.role}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : null}

        <textarea
          ref={textareaRef}
          rows={1}
          placeholder="随心输入，默认交给 CEO 助理；@ 指定智能体；可直接粘贴或拖入图片…"
          aria-label="输入框"
          value={text}
          disabled={disabled}
          onChange={(e) => handleChange(e.target.value)}
          onPaste={(e) => {
            const files = e.clipboardData?.files;
            if (files && files.length > 0) {
              e.preventDefault();
              addImages(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleSend();
              return;
            }
            if (pickerOpen && filtered.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) => (i + 1) % filtered.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickBot(filtered[Math.min(activeIndex, filtered.length - 1)]);
                return;
              }
            }
            // Enter sends, Shift+Enter inserts a newline. Never send while
            // an IME is composing (Enter then confirms the composition).
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSend();
              return;
            }
            if (e.key === "@") {
              if (!pickerOpen) openPicker(true);
              return;
            }
            if (e.key === "Escape") {
              setPickerOpen(false);
            }
          }}
        />
        <div className="composer-actions">
          <div className="composer-tools">
            <button
              type="button"
              className="composer-tool"
              disabled={disabled}
              onClick={() => openPicker(false)}
              aria-label="提及智能体"
              title="提及"
            >
              <IconAt size={16} />
            </button>
            <button
              type="button"
              className="composer-quiet"
              disabled={disabled}
              onClick={onAbort}
            >
              全部中止
            </button>
            <button
              type="button"
              className={`composer-tool composer-fold${expanded ? " is-open" : ""}`}
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
              aria-label={expanded ? "收起输入框" : "展开输入框"}
              title={expanded ? "收起" : "展开"}
            >
              <IconChevronDown />
            </button>
          </div>
          <button
            type="button"
            className="composer-send"
            disabled={
              disabled || sending || uploading || (!text.trim() && pendingImages.length === 0)
            }
            onClick={handleSend}
            aria-label={sending || uploading ? "发送中" : "发送"}
            title="发送"
          >
            <IconArrowUp />
          </button>
        </div>
      </div>
      <p className="composer-hint">
        Enter 发送 · Shift + Enter 换行 · 智能体执行可能需要几分钟
      </p>
    </footer>
  );
}
