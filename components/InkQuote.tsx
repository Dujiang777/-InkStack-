"use client";

// 今日墨签 —— 每日一句（按日期确定性抽取，全站同一天同一句），一键复制分享
import { useState } from "react";

export default function InkQuote({ text, from }: { text: string; from: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const payload = `「${text}」—— ${from}（墨栈今日墨签）`;
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      // 剪贴板不可用时静默失败
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="ink-quote" aria-label="今日墨签">
      <i className="iq-seal" aria-hidden="true">
        签
      </i>
      <span className="kicker">
        今日墨签 · {from}
      </span>
      <p className="iq-text">{text}</p>
      <button className="iq-copy" onClick={copy}>
        {copied ? "已复制 ✓" : "复制分享"}
      </button>
    </div>
  );
}
