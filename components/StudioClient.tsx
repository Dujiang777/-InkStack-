"use client";

// AI 创作台：
// - 草稿自动保存（登录用户 → MySQL drafts 表；未登录 → localStorage 降级）
// - 编辑器工具栏：图片（上传/粘贴/拖拽）、emoji 面板、代码块、链接
// - AI 生成结果可一键插入光标处 / 替换全文 / 复制；起标题模式逐条「用作标题」
// - 字数 / 段落 / 预计阅读 / 修订次数统计
import { useEffect, useMemo, useRef, useState } from "react";

const DOC_NAME = "pgvector-blog.md";

const EMOJI_GROUPS: { name: string; list: string[] }[] = [
  { name: "常用", list: ["😀", "😅", "😂", "🤔", "😳", "😱", "🥲", "😴", "🤡", "😎", "🥳", "😤"] },
  { name: "手势", list: ["👍", "👎", "👏", "🙏", "💪", "🤝", "✌️", "🤙", "👀", "🫡", "🤌", "🫶"] },
  { name: "技术", list: ["🐛", "🔥", "💥", "✨", "⚡", "🚀", "🧠", "🔧", "🧪", "📦", "🏗️", "🧱"] },
  { name: "码农", list: ["💻", "🖥️", "⌨️", "🖱️", "🗑️", "📎", "📌", "🔒", "🔑", "💾", "🖨️", "⚙️"] },
  { name: "心情", list: ["🆗", "🆒", "🎯", "⚠️", "❌", "✅", "❓", "❗", "💯", "🆘", "🛑", "🏁"] },
];

const DRAFT = `# pgvector 够用了：别急着上专用向量库

技术选型最大的陷阱，是把「别人的规模」当成自己的规模。

当你的文章总量还不到一万篇，pgvector 一个 HNSW 索引就能把召回压到 95% 以上，查询耗时个位数毫秒。这时候引入一个独立的向量数据库，你买到的是：多一个要运维的有状态服务、多一份内存账单，以及团队里每一个新人都要重新学一遍的部署文档。

真正的分界线在哪里？我的答案是：**当过滤条件开始和向量检索深度耦合的时候。**`;

const TOPICS = [
  { no: "01", title: "百万级向量之后：我迁移到专用向量库的那一周", meta: "热度 92 · 与你的专栏强相关" },
  { no: "02", title: "混合检索实战：关键词召回 + 向量召回的正确融合比例", meta: "热度 85 · 补全你的 RAG 系列" },
  { no: "03", title: "给博客装上「文章即应用」：让读者直接跑你的代码块", meta: "热度 78 · 平台新功能蹭点" },
];

type Result = {
  mode: "continue" | "polish" | "title";
  text: string;
  tail: string;
  fallback: boolean;
};

type Props = {
  /** 编辑模式：传入要编辑的文章 slug（书房「编辑」跳转 ?edit=slug） */
  editSlug?: string | null;
  isAdmin?: boolean;
};

export default function StudioClient({ editSlug = null, isAdmin = false }: Props) {
  const [draft, setDraft] = useState(DRAFT);
  /* ---------- 发布台状态 ---------- */
  const [pubTitle, setPubTitle] = useState("");
  const [pubSummary, setPubSummary] = useState("");
  const [pubTags, setPubTags] = useState("");
  const [pubLabel, setPubLabel] = useState("");
  const [pubPrice, setPubPrice] = useState("");
  const [pubDiscount, setPubDiscount] = useState("");
  const [pubDiscountUntil, setPubDiscountUntil] = useState("");
  const [pubBusy, setPubBusy] = useState(false);
  const [pubMsg, setPubMsg] = useState("");
  const [pubErr, setPubErr] = useState("");
  const [editInfo, setEditInfo] = useState<{ reviewStatus: string; reviewNote: string | null; status: string } | null>(null);
  /** 新建的草稿文章 slug（新稿存草稿后转入编辑态，后续走 PUT 更新） */
  const [newDraftSlug, setNewDraftSlug] = useState<string | null>(null);
  /** 我的专栏（发布台勾选用）与勾选集合 */
  const [mySeries, setMySeries] = useState<{ id: number; title: string; slugs: string[] }[]>([]);
  const [pickedSeries, setPickedSeries] = useState<number[]>([]);
  const [label, setLabel] = useState("OUTPUT · 待命");
  const [result, setResult] = useState<Result | null>(null);
  const [shown, setShown] = useState("");
  const [busy, setBusy] = useState(false);
  const [showTopics, setShowTopics] = useState(false);
  const [saveState, setSaveState] = useState("读取草稿…");
  const [revisions, setRevisions] = useState(0);
  const [copied, setCopied] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipFirst = useRef(true);

  const resultReady = result !== null && !busy;

  /* ---------- 工具栏：通用插入 ---------- */
  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 2400);
  }

  async function uploadImage(file: File) {
    if (uploading) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body: fd });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        flash(data.error ?? "上传失败");
        return;
      }
      insertAtCursor(`\n\n![${file.name.replace(/\.[^.]+$/, "")}](${data.url})\n\n`);
      flash("图片已上传并插入");
    } catch {
      flash("网络异常，上传失败");
    } finally {
      setUploading(false);
    }
  }

  function insertCodeBlock() {
    const lang = "js";
    insertAtCursor(`\n\n\`\`\`${lang}\n// 在这里写下你的代码\n\`\`\`\n\n`);
  }

  function insertLink() {
    const url = prompt("输入链接地址（https://…）：");
    if (!url) return;
    const label = prompt("链接显示文字（留空用地址）：") || url;
    insertAtCursor(`[${label}](${url})`);
    // 非白名单域名自动提交审核
    fetch("/api/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    })
      .then((r) => r.ok && r.json())
      .then((d) => d?.message && flash(d.message))
      .catch(() => {});
  }

  /* ---------- 粘贴 / 拖拽图片 ---------- */
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
    if (file) {
      e.preventDefault();
      uploadImage(file);
    }
  }

  function onDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
    if (file) {
      e.preventDefault();
      uploadImage(file);
    }
  }

  /* ---------- 自动保存（真实：MySQL drafts 表，未登录降级 localStorage） ---------- */
  useEffect(() => {
    fetch("/api/drafts?title=" + encodeURIComponent(DOC_NAME))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.draft?.content) {
          setDraft(d.draft.content);
          setSaveState(`云端草稿 · ${d.draft.updatedAt}`);
          setRevisions(1);
        } else if (d === null) {
          const local = localStorage.getItem("ink-draft-" + DOC_NAME);
          if (local) setDraft(local);
          setSaveState("本地暂存 · 未登录");
        } else {
          setSaveState("云端草稿 · 新文档");
        }
      })
      .catch(() => setSaveState("本地暂存 · 未登录"));
  }, []);

  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("保存中…");
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/drafts", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: DOC_NAME, content: draft }),
        });
        if (res.ok) {
          const d = (await res.json()) as { savedAt?: string };
          setSaveState(`已保存至云端 · ${d.savedAt ?? ""}`);
          setRevisions((n) => n + 1);
        } else {
          localStorage.setItem("ink-draft-" + DOC_NAME, draft);
          setSaveState("本地暂存 · 登录后同步云端");
        }
      } catch {
        localStorage.setItem("ink-draft-" + DOC_NAME, draft);
        setSaveState("本地暂存 · 网络异常");
      }
    }, 1200);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [draft]);

  /* ---------- 发布台表单自动保存（localStorage，防误关丢稿；编辑模式不恢复） ---------- */
  const pubRestored = useRef(false);
  useEffect(() => {
    if (!editSlug) {
      try {
        const raw = localStorage.getItem("ink-pubform");
        if (raw) {
          const f = JSON.parse(raw) as { title?: string; summary?: string; tags?: string; label?: string };
          if (f.title || f.summary || f.tags || f.label) {
            setPubTitle(f.title ?? "");
            setPubSummary(f.summary ?? "");
            setPubTags(f.tags ?? "");
            setPubLabel(f.label ?? "");
            setPubMsg("已恢复上次未提交的发布信息");
          }
        }
      } catch {
        /* 忽略损坏的暂存 */
      }
    }
    pubRestored.current = true;
  }, [editSlug]);

  useEffect(() => {
    if (!pubRestored.current) return;
    try {
      localStorage.setItem(
        "ink-pubform",
        JSON.stringify({ title: pubTitle, summary: pubSummary, tags: pubTags, label: pubLabel })
      );
    } catch {
      /* 存储满等情况静默 */
    }
  }, [pubTitle, pubSummary, pubTags, pubLabel]);

  /* ---------- 统计 ---------- */
  const stats = useMemo(() => {
    const chars = draft.replace(/\s/g, "").length;
    const paras = draft.split(/\n{2,}/).filter((p) => p.trim()).length;
    const minutes = Math.max(1, Math.round(chars / 400));
    return { chars, paras, minutes };
  }, [draft]);

  /* ---------- 编辑模式：回填文章原文 ---------- */
  useEffect(() => {
    if (!editSlug) return;
    let alive = true;
    fetch(`/api/articles/${editSlug}/raw`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.article) return;
        const a = d.article as {
          title: string;
          md: string;
          summary: string;
          tags: string[];
          coverLabel: string;
          reviewStatus: string;
          reviewNote: string | null;
          status: string;
          unlockPrice?: number;
          discountPrice?: number;
          discountUntil?: string | null;
        };
        setDraft(a.md);
        setPubTitle(a.title);
        setPubSummary(a.summary ?? "");
        setPubTags((a.tags ?? []).join(", "));
        setPubLabel(a.coverLabel ?? "");
        setPubPrice(a.unlockPrice ? String(a.unlockPrice) : "");
        setPubDiscount(a.discountPrice ? String(a.discountPrice) : "");
        setPubDiscountUntil(a.discountUntil ? a.discountUntil.slice(0, 16) : "");
        setEditInfo({ reviewStatus: a.reviewStatus, reviewNote: a.reviewNote, status: a.status });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [editSlug]);

  /* ---------- 发布台：拉取我的专栏；编辑模式回填当前所属 ---------- */
  useEffect(() => {
    let alive = true;
    fetch("/api/series")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.series) return;
        const list = (d.series as { id: number; title: string; items?: { slug: string }[] }[]).map((s) => ({
          id: s.id,
          title: s.title,
          slugs: (s.items ?? []).map((i) => i.slug),
        }));
        setMySeries(list);
        if (editSlug) {
          setPickedSeries(list.filter((s) => s.slugs.includes(editSlug)).map((s) => s.id));
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [editSlug]);

  /* ---------- 发布台 ---------- */
  function titleFromDraft(): string {
    const line = draft.split("\n").find((l) => l.trim().startsWith("#"));
    return (line ?? "").replace(/^#+\s*/, "").trim();
  }

  /** 当前编辑目标：URL 带入的文章，或本次会话新存草稿的文章 */
  const targetSlug = editSlug || newDraftSlug;
  /** 是否处于草稿编辑态（决定主按钮语义与「存草稿」显隐） */
  const editingDraft = editInfo?.status === "draft" || Boolean(newDraftSlug);

  async function publish(opts?: { draft?: boolean }) {
    if (pubBusy) return;
    const title = pubTitle.trim() || titleFromDraft();
    if (!title) {
      setPubErr("标题不能为空（在发布台填写，或正文用 # 起头）");
      return;
    }
    const isDraftSave = Boolean(opts?.draft);
    setPubBusy(true);
    setPubErr("");
    setPubMsg("");
    try {
      const payload: Record<string, unknown> = {
        title,
        md: draft,
        summary: pubSummary.trim(),
        tags: pubTags
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 6),
        coverLabel: pubLabel.trim(),
        unlockPrice: Math.max(0, Math.min(10_000, Math.floor(Number(pubPrice) || 0))),
        discountPrice: Number(pubDiscount) || 0,
        discountUntil: pubDiscountUntil ? new Date(pubDiscountUntil).toISOString() : null,
      };
      let res: Response;
      if (targetSlug) {
        // 编辑已有文章（含本次会话新存的草稿）
        if (isDraftSave) payload.draft = true;
        else if (editingDraft) payload.publish = true; // 草稿转正式发布
        res = await fetch(`/api/articles/${targetSlug}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        payload.draft = isDraftSave;
        res = await fetch("/api/articles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      const d = (await res.json()) as {
        ok?: boolean;
        error?: string;
        reviewPending?: boolean;
        reviewStatus?: string;
        reward?: number;
        capped?: boolean;
        slug?: string;
        publishedFromDraft?: boolean;
      };
      if (!res.ok || !d.ok) {
        setPubErr(d.error ?? (isDraftSave ? "保存草稿失败" : "发布失败"));
        return;
      }
      if (isDraftSave) {
        if (!targetSlug && d.slug) setNewDraftSlug(d.slug);
        setPubMsg("草稿已保存 · 书房「草稿箱」可继续编辑；Ctrl+S 随时快存");
        return; // 存草稿不跳转，留在编辑器
      }
      const pending = targetSlug ? d.reviewStatus === "pending" : Boolean(d.reviewPending);
      // 同步所属专栏（勾选的加入、取消的移出；存草稿不走到这里）
      let seriesNote = "";
      const curSlug = targetSlug || d.slug || "";
      if (curSlug && mySeries.length) {
        const results = await Promise.all(
          mySeries.map(async (s) => {
            const picked = pickedSeries.includes(s.id);
            const has = s.slugs.includes(curSlug);
            if (picked === has) return true;
            const slugs = picked ? [...s.slugs, curSlug] : s.slugs.filter((x) => x !== curSlug);
            const r2 = await fetch(`/api/series/${s.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ slugs }),
            });
            return r2.ok;
          })
        );
        if (results.every(Boolean) && pickedSeries.length) seriesNote = " · 专栏已同步";
        else if (!results.every(Boolean)) seriesNote = " · 专栏待文章过审后可在书房调整";
      }
      try {
        localStorage.removeItem("ink-pubform"); // 正式发布成功，清掉发布台暂存
      } catch {
        /* ignore */
      }
      setPubMsg(
        (targetSlug ? (d.publishedFromDraft ? "草稿已发布" : "更新已保存") : "发布成功") +
          (pending ? " · 已提交审核，通过后公开展示（书房可查状态）" : " · 已公开") +
          (d.reward ? ` · 发布奖励 +${d.reward} 滴墨水` : "") +
          (d.capped ? "（今日发文奖励已达上限）" : "") +
          seriesNote
      );
      setTimeout(() => {
        window.location.href = "/study";
      }, 1600);
    } catch {
      setPubErr("网络异常，请稍后再试");
    } finally {
      setPubBusy(false);
    }
  }

  /* ---------- Ctrl+S / Cmd+S 快存草稿 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        publish({ draft: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* ---------- AI 生成 ---------- */
  async function run(mode: "continue" | "polish" | "title") {
    if (busy) return;
    setBusy(true);
    setResult(null);
    setCopied(false);
    try {
      const res = await fetch("/api/ai/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, draft, author: "陈屿" }),
      });
      const data = (await res.json()) as {
        label?: string;
        text?: string;
        error?: string;
        pointsNote?: string;
        fallback?: boolean;
      };
      if (!res.ok || data.error) {
        setLabel("OUTPUT · 请求被拒");
        setShown(data.error ?? "生成失败，请重试。");
        setBusy(false);
        return;
      }
      const full = data.text ?? "";
      setLabel(`OUTPUT · ${data.label ?? "生成"}`);
      setResult({
        mode,
        text: full,
        tail: data.fallback
          ? "智能体服务未响应，本次为模板演示，未扣墨水"
          : data.pointsNote ?? "已扣 10 滴墨水",
        fallback: Boolean(data.fallback),
      });
      setShown("");
      let pos = 0;
      const step = Math.max(1, Math.round(full.length / 80));
      const timer = setInterval(() => {
        pos = Math.min(full.length, pos + step);
        setShown(full.slice(0, pos));
        if (pos >= full.length) {
          clearInterval(timer);
          setBusy(false);
        }
      }, 16);
    } catch {
      setLabel("OUTPUT · 网络异常");
      setShown("网络异常，请重试。");
      setBusy(false);
    }
  }

  /* ---------- 结果操作 ---------- */
  function insertAtCursor(text: string) {
    const ta = taRef.current;
    if (!ta) {
      setDraft((d) => d + "\n\n" + text);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = draft.slice(0, start) + text + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + text.length;
    });
  }

  function useAsTitle(title: string) {
    const lines = draft.split("\n");
    if (lines[0]?.startsWith("# ")) {
      lines[0] = `# ${title}`;
      setDraft(lines.join("\n"));
    } else {
      setDraft(`# ${title}\n\n` + draft);
    }
  }

  async function copyResult() {
    if (!result) return;
    await navigator.clipboard.writeText(result.text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  const titleLines = result?.mode === "title"
    ? result.text.split("\n").map((l) => l.replace(/^\d+[.、]\s*/, "").trim()).filter(Boolean)
    : [];

  return (
    <div className="studio">
      {/* ---------- 左：稿纸编辑器 ---------- */}
      <section className="studio-editor" aria-label="草稿编辑器">
        {/* 发布台 */}
        <div className="publish-desk">
          <div className="pd-head">
            <b className="pd-title">{targetSlug ? (editingDraft ? "编辑草稿" : "更新文章") : "发布到墨栈"}</b>
            {editingDraft && <span className="pd-pending">草稿仅自己可见，发布后进入审核流</span>}
            {editInfo?.reviewStatus === "rejected" && (
              <span className="pd-reject">上次审核未通过：{editInfo.reviewNote ?? "不符合社区规范"}（修改后重新提交）</span>
            )}
            {editInfo?.reviewStatus === "pending" && (
              <span className="pd-pending">当前为待审核状态，保存更新后将重新排入审核队列</span>
            )}
          </div>
          <div className="pd-row">
            <input
              className="pd-input"
              value={pubTitle}
              onChange={(e) => setPubTitle(e.target.value)}
              placeholder="文章标题（留空则取正文首个 # 标题）"
              aria-label="文章标题"
              maxLength={200}
            />
          </div>
          <div className="pd-row pd-grid">
            <input
              className="pd-input"
              value={pubSummary}
              onChange={(e) => setPubSummary(e.target.value)}
              placeholder="摘要（可空）"
              aria-label="摘要"
              maxLength={500}
            />
            <input
              className="pd-input"
              value={pubTags}
              onChange={(e) => setPubTags(e.target.value)}
              placeholder="标签，逗号分隔"
              aria-label="标签"
            />
            <input
              className="pd-input pd-label"
              value={pubLabel}
              onChange={(e) => setPubLabel(e.target.value)}
              placeholder="栏目字（如：卷一）"
              aria-label="栏目字"
              maxLength={32}
            />
            <input
              className="pd-input pd-price"
              value={pubPrice}
              onChange={(e) => setPubPrice(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="解锁定价（点墨，留空 = 免费）"
              aria-label="解锁定价"
              inputMode="numeric"
              maxLength={5}
            />
            {Number(pubPrice) > 0 && (
              <>
                <input
                  className="pd-input pd-discount"
                  value={pubDiscount}
                  onChange={(e) => setPubDiscount(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder={`早鸟价（< ${pubPrice}，留空 = 不折扣）`}
                  aria-label="早鸟价"
                  inputMode="numeric"
                  maxLength={5}
                />
                <input
                  className="pd-input pd-discount-until"
                  type="datetime-local"
                  value={pubDiscountUntil}
                  onChange={(e) => setPubDiscountUntil(e.target.value)}
                  aria-label="早鸟价截止时间"
                  title="早鸟价截止时间（最长 30 天）"
                />
              </>
            )}
          </div>
          {mySeries.length > 0 && (
            <div className="pd-row pd-series">
              <span className="pd-series-label">所属专栏</span>
              <div className="pd-series-opts">
                {mySeries.map((s) => {
                  const on = pickedSeries.includes(s.id);
                  return (
                    <label key={s.id} className={"pd-series-chip" + (on ? " on" : "")}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) =>
                          setPickedSeries((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))
                        }
                      />
                      《{s.title}》
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          <div className="pd-row pd-actions">
            <button className="pd-submit" onClick={() => publish()} disabled={pubBusy}>
              {pubBusy
                ? "提交中…"
                : targetSlug
                  ? editingDraft
                    ? "发布文章"
                    : "保存并重新提交审核"
                  : "提交发布"}
            </button>
            {(!targetSlug || editingDraft) && (
              <button className="pd-draft" onClick={() => publish({ draft: true })} disabled={pubBusy}>
                存草稿
              </button>
            )}
            <span className="pd-note">
              {isAdmin
                ? "管理员发布直接公开 · Ctrl+S 快存草稿"
                : "普通发布需审核，通过后公开展示 · 发布奖励 +20 滴墨水/日 · Ctrl+S 快存草稿"}
            </span>
          </div>
          {pubMsg && <p className="adm-ok">{pubMsg}</p>}
          {pubErr && <p className="mig-error">✕ {pubErr}</p>}
        </div>

        <div className="editor-bar">
          <span className="dot"></span>
          <span className="dot"></span>
          <span className="dot filled"></span>
          <span className="doc-name">{DOC_NAME}</span>
          <span className={"save" + (saveState.startsWith("已保存") ? " saved" : "")}>{saveState}</span>
        </div>

        {/* 工具栏 */}
        <div className="editor-tools" role="toolbar" aria-label="插入工具">
          <button onClick={() => fileRef.current?.click()} disabled={uploading} title="上传图片（也可直接粘贴/拖入）">
            {uploading ? "上传中…" : "▣ 图片"}
          </button>
          <button onClick={() => setShowEmoji((v) => !v)} title="插入表情">☺ 表情</button>
          <button onClick={insertCodeBlock} title="插入代码块">{"</>"} 代码</button>
          <button onClick={insertLink} title="插入链接（外链自动提交审核）">🔗 链接</button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadImage(f);
              e.target.value = "";
            }}
          />
        </div>

        {showEmoji && (
          <div className="emoji-panel" aria-label="表情选择">
            {EMOJI_GROUPS.map((g) => (
              <div key={g.name} className="emoji-group">
                <span className="emoji-group-name">{g.name}</span>
                {g.list.map((em) => (
                  <button
                    key={em}
                    className="emoji-item"
                    onClick={() => insertAtCursor(em)}
                    aria-label={`插入 ${em}`}
                  >
                    {em}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={onPaste}
          onDrop={onDrop}
          aria-label="文章草稿编辑器"
          spellCheck={false}
          placeholder="落笔即成稿 — 支持粘贴或拖入图片、emoji、代码块，Markdown 全语法"
        />
        <div className="stat-strip">
          <span><b>{stats.chars}</b> 字</span>
          <span><b>{stats.paras}</b> 段</span>
          <span>约 <b>{stats.minutes}</b> 分钟读完</span>
          <span>修订 <b>{revisions}</b> 次</span>
          <span>Markdown · 图片 · 代码 · 链接全支持</span>
        </div>
        {toast && <div className="editor-toast" role="status">{toast}</div>}
      </section>

      {/* ---------- 右：AI 编辑部 ---------- */}
      <aside className="ai-panel" aria-label="AI 写作助手">
        <div className="ai-head">
          <b>AI 编辑部</b>
          <span>DRAFT DESK · 严谨</span>
        </div>
        <div className="ai-actions">
          <button onClick={() => run("continue")} disabled={busy}>续写</button>
          <button onClick={() => run("polish")} disabled={busy}>润色本段</button>
          <button onClick={() => run("title")} disabled={busy}>起 5 个标题</button>
          <button onClick={() => setShowTopics((v) => !v)} disabled={busy}>
            推荐选题 {showTopics ? "▲" : "▼"}
          </button>
        </div>

        {showTopics && (
          <div className="topic-cards">
            {TOPICS.map((t) => (
              <button
                key={t.no}
                className="topic-card"
                onClick={() => insertAtCursor(`\n\n# ${t.title}\n\n（选题已载入，按此展开…）`)}
              >
                <span className="hot">{t.no}</span>
                <span>
                  {t.title}
                  <small>{t.meta} · 点击插入草稿</small>
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="ai-output" aria-live="polite">
          <span className="label">{label}</span>
          {shown}
          {busy && <span className="caret">▌</span>}
        </div>

        {resultReady && result && (
          <div className="result-actions">
            {result.mode === "title" ? (
              <div className="title-options">
                <p className="hint">点击任一标题替换文章主标题：</p>
                {titleLines.map((t, i) => (
                  <button key={i} className="title-line" onClick={() => useAsTitle(t)}>
                    <span className="no">{String(i + 1).padStart(2, "0")}</span>
                    {t}
                  </button>
                ))}
              </div>
            ) : (
              <>
                <button className="act primary" onClick={() => insertAtCursor("\n\n" + result.text)}>
                  ✎ 插入光标处
                </button>
                <button
                  className="act"
                  onClick={() => {
                    if (confirm("确定用 AI 结果替换全部草稿内容？原内容将丢失。")) setDraft(result.text);
                  }}
                >
                  替换全文
                </button>
              </>
            )}
            <button className="act" onClick={copyResult}>{copied ? "已复制 ✓" : "复制"}</button>
            <p className="points-note">⚠ AI 辅助生成 · {result.tail}</p>
          </div>
        )}
      </aside>
    </div>
  );
}
