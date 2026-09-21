// 轻量代码高亮（零依赖，编辑风配色）
// 支持：js/ts/jsx/tsx/python/json/bash/sh/sql/css/html/generic
// 思路：先转义 HTML，再用一个 tokenizer 逐段匹配注释/字符串/关键字/数字/行内标签

const KEYWORDS: Record<string, string[]> = {
  js: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "extends", "new", "typeof", "instanceof", "await", "async", "yield", "try", "catch", "finally", "throw", "switch", "case", "break", "continue", "import", "from", "export", "default", "delete", "in", "of", "this", "super"],
  py: ["def", "return", "if", "elif", "else", "for", "while", "class", "import", "from", "as", "with", "try", "except", "finally", "raise", "yield", "lambda", "pass", "break", "continue", "global", "nonlocal", "assert", "del", "in", "is", "not", "and", "or", "None", "True", "False", "self", "async", "await"],
  sh: ["echo", "cd", "ls", "if", "then", "else", "fi", "for", "do", "done", "while", "case", "esac", "function", "export", "source", "return", "local", "set", "npm", "node", "python", "pip", "git", "docker", "mysql", "curl", "sudo", "apt", "brew"],
  sql: ["SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "DROP", "ALTER", "ADD", "INDEX", "KEY", "PRIMARY", "FOREIGN", "REFERENCES", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP", "BY", "ORDER", "LIMIT", "OFFSET", "AND", "OR", "NOT", "NULL", "AS", "DISTINCT", "COUNT", "SUM", "AVG", "IF", "EXISTS", "UNIQUE", "DEFAULT", "ENGINE", "CHARSET"],
};

const ALIAS: Record<string, string> = {
  javascript: "js", typescript: "js", ts: "js", jsx: "js", tsx: "js", mjs: "js", cjs: "js",
  python: "py", py3: "py",
  bash: "sh", shell: "sh", zsh: "sh", powershell: "sh", console: "sh",
  mysql: "sql", postgres: "sql", psql: "sql",
  json: "js", yaml: "sh", toml: "sh", ini: "sh",
  css: "css", scss: "css", less: "css",
  html: "html", xml: "html", svg: "html", vue: "html",
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function highlightLine(line: string, lang: string): string {
  if (!line) return "";
  let out = "";
  let i = 0;
  const kw = KEYWORDS[lang] ?? KEYWORDS.js;

  while (i < line.length) {
    const rest = line.slice(i);

    // 行注释
    const commentMatch =
      lang === "py" ? rest.match(/^#.*/) :
      lang === "sh" ? rest.match(/^#.*/) :
      lang === "sql" ? rest.match(/^(--|#).*/) :
      rest.match(/^\/\/.*/);
    if (commentMatch) {
      out += `<span class="tok-c">${esc(commentMatch[0])}</span>`;
      break;
    }

    // 字符串（含模板串）
    const strMatch = rest.match(/^(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)/);
    if (strMatch && (strMatch[0][0] === '"' || strMatch[0][0] === "'" || strMatch[0][0] === "`")) {
      out += `<span class="tok-s">${esc(strMatch[0])}</span>`;
      i += strMatch[0].length;
      continue;
    }

    // 数字
    const numMatch = rest.match(/^(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/);
    if (numMatch) {
      out += `<span class="tok-n">${esc(numMatch[0])}</span>`;
      i += numMatch[0].length;
      continue;
    }

    // 标识符（可能是关键字/函数名）
    const idMatch = rest.match(/^[A-Za-z_$][\w$]*/);
    if (idMatch) {
      const word = idMatch[0];
      const isKeyword = kw.includes(word) || (lang === "sql" && kw.includes(word.toUpperCase()) && word === word.toUpperCase());
      const isFn = line[i + word.length] === "(";
      out += isKeyword
        ? `<span class="tok-k">${esc(word)}</span>`
        : isFn
          ? `<span class="tok-f">${esc(word)}</span>`
          : esc(word);
      i += word.length;
      continue;
    }

    // HTML/JSX 标签
    if (lang === "html" && (rest[0] === "<" || /^\/|>/.test(rest.slice(0, 2)))) {
      const tagMatch = rest.match(/^<\/?[A-Za-z][\w:-]*/);
      if (tagMatch) {
        out += `&lt;${rest.startsWith("</") ? "/" : ""}<span class="tok-k">${esc(tagMatch[0].replace(/^<\/?/, ""))}</span>`;
        i += tagMatch[0].length;
        continue;
      }
    }

    out += esc(rest[0]);
    i += 1;
  }
  return out;
}

export function highlightCode(code: string, rawLang: string): string {
  const lang = ALIAS[(rawLang || "").toLowerCase()] ?? "js";
  const lines = code.replace(/\n$/, "").split("\n");
  return lines
    .map((l) => highlightLine(l, lang))
    .join("\n");
}
