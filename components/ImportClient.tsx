"use client";

// 迁移工坊：RSS 订阅抓取 / Markdown 文件拖拽导入
// 导入结果分「已入库 / 已跳过」两栏展示，入库文章即时可被分身检索
import { useRef, useState } from "react";

type ImportResult = {
  source: string;
  imported: number;
  articles: { title: string; slug: string }[];
  skipped: { title: string; reason: string }[];
};

export default function ImportClient() {
  const [tab, setTab] = useState<"rss" | "md">("rss");
  const [url, setUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function pickFiles(list: FileList | null) {
    if (!list) return;
    const md = Array.from(list).filter((f) => /\.(md|markdown|txt)$/i.test(f.name));
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...md.filter((f) => !names.has(f.name + f.size))].slice(0, 20);
    });
    setError("");
  }

  async function submitRss() {
    if (busy || !url.trim()) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "导入失败");
      else setResult(data as ImportResult);
    } catch {
      setError("网络异常，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function submitMd() {
    if (busy || !files.length) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const form = new FormData();
      files.forEach((f) => form.append("files", f));
      const res = await fetch("/api/import", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "导入失败");
      else {
        setResult(data as ImportResult);
        setFiles([]);
      }
    } catch {
      setError("网络异常，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mig-wrap">
      <div className="mig-tabs" role="tablist">
        <button className={"mig-tab" + (tab === "rss" ? " active" : "")} onClick={() => setTab("rss")} role="tab" aria-selected={tab === "rss"}>
          <span className="no">甲</span>RSS 订阅迁移
        </button>
        <button className={"mig-tab" + (tab === "md" ? " active" : "")} onClick={() => setTab("md")} role="tab" aria-selected={tab === "md"}>
          <span className="no">乙</span>Markdown 文件
        </button>
      </div>

      {tab === "rss" ? (
        <div className="mig-panel">
          <label className="mig-label" htmlFor="rss-url">订阅源地址（RSS 2.0 / Atom）</label>
          <div className="mig-row">
            <input
              id="rss-url"
              className="mig-input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-blog.com/feed.xml"
              onKeyDown={(e) => e.key === "Enter" && submitRss()}
            />
            <button className="mig-go" onClick={submitRss} disabled={busy || !url.trim()}>
              {busy ? "抓取中…" : "抓取导入"}
            </button>
          </div>
          <p className="mig-hint">将抓取最新 20 篇文章；外站 HTML 会自动消毒后入库，发布时间沿用原站。</p>
        </div>
      ) : (
        <div className="mig-panel">
          <div
            className={"dropzone" + (dragging ? " hover" : "")}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); pickFiles(e.dataTransfer.files); }}
            onClick={() => fileInput.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="拖拽或点击选择 Markdown 文件"
          >
            <span className="dz-seal" aria-hidden="true">稿</span>
            <p className="dz-main">把 .md 文件拖进来</p>
            <p className="dz-sub">或点击选择 · 一次最多 20 个 · 单文件 ≤ 300KB</p>
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".md,.markdown,.txt"
            hidden
            onChange={(e) => pickFiles(e.target.files)}
          />
          {files.length > 0 && (
            <ul className="file-list">
              {files.map((f) => (
                <li className="file-chip" key={f.name + f.size}>
                  <span className="fname">{f.name}</span>
                  <span className="fsize">{(f.size / 1024).toFixed(0)} KB</span>
                  <button className="fx" aria-label={`移除 ${f.name}`} onClick={() => setFiles((p) => p.filter((x) => x !== f))}>×</button>
                </li>
              ))}
            </ul>
          )}
          <div className="mig-row">
            <span className="mig-count">待导入 {files.length} 个文件</span>
            <button className="mig-go" onClick={submitMd} disabled={busy || !files.length}>
              {busy ? "导入中…" : "开始导入"}
            </button>
          </div>
          <p className="mig-hint">标题自动取文内首个一级标题，没有则用文件名；摘要取首段纯文本。</p>
        </div>
      )}

      {error && <p className="mig-error" role="alert">✕ {error}</p>}

      {result && (
        <div className="mig-result">
          <p className="mr-head">
            导入完成：<b>{result.imported}</b> 篇入库
            {result.skipped.length > 0 && <> · 跳过 <b>{result.skipped.length}</b> 篇</>}
          </p>
          {result.articles.length > 0 && (
            <ul className="mr-list ok">
              {result.articles.map((a) => (
                <li key={a.slug}>
                  <span className="mark" aria-hidden="true">✓</span>
                  <a href={`/article/${a.slug}`} target="_blank" rel="noopener">{a.title}</a>
                </li>
              ))}
            </ul>
          )}
          {result.skipped.length > 0 && (
            <ul className="mr-list skip">
              {result.skipped.map((s, i) => (
                <li key={i}>
                  <span className="mark" aria-hidden="true">—</span>
                  <span className="t">{s.title}</span>
                  <span className="reason">{s.reason}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mr-note">✦ 分身已可检索这些文章——去文章页问一句试试。</p>
        </div>
      )}
    </div>
  );
}
