// 印章头像体系（v17.4 印章工坊）：
// - 印泥色（tone）：全站头像从「清一色墨圆」升级为各有印色的印章
// - 印式（shape）：圆章 / 方章 / 阳文（描边）
// - 数据约定：users.avatar_tone = ''（随缘派定）| 'ink'（经典墨）| 色板 key
//             users.avatar_shape = ''（圆章）| 'fang' | 'yangwen'
// - 渲染约定：拿得到 tone 就用 tone；拿不到就按用户 id 确定性派色（同一人全站同色）

export type AvatarTone = {
  key: string;
  name: string;
  /** 日间印底色 */
  light: string;
  /** 夜间印底色 */
  night: string;
  /** 阳文（描边）模式的前景色，日/夜同色 */
  fgLight: string;
  fgNight: string;
};

/** 色板：色名取自传统印泥/矿物色，保证与暖纸底的对比度 */
export const AVATAR_TONES: AvatarTone[] = [
  { key: "ink", name: "经典墨", light: "#211C14", night: "#E8DFCE", fgLight: "#F6F1E7", fgNight: "#1C1812" },
  { key: "zhusha", name: "朱砂", light: "#C2401A", night: "#D4552C", fgLight: "#FBF2E8", fgNight: "#1C1812" },
  { key: "dailan", name: "黛蓝", light: "#2E4E6E", night: "#5B84AB", fgLight: "#F2F5F0", fgNight: "#14181D" },
  { key: "zhuqing", name: "竹青", light: "#3E6B4F", night: "#5F8F72", fgLight: "#F2F6EF", fgNight: "#131A15" },
  { key: "zheshi", name: "赭石", light: "#96632B", night: "#B57F42", fgLight: "#FAF3E6", fgNight: "#1A140C" },
  { key: "zitang", name: "紫棠", light: "#5D3A6B", night: "#82589A", fgLight: "#F6F1F4", fgNight: "#17121B" },
  { key: "yanzhi", name: "胭脂", light: "#A03448", night: "#C04C62", fgLight: "#FAEFF0", fgNight: "#1B1214" },
];

/** 随缘派定用的色池（不含经典墨——随缘的意义就是让全站百花齐放） */
const AUTO_POOL = AVATAR_TONES.filter((t) => t.key !== "ink");

export const AVATAR_SHAPES: { key: string; name: string; desc: string }[] = [
  { key: "", name: "圆章", desc: "圆润相安，全局默认" },
  { key: "fang", name: "方章", desc: "金石气：微倾方印，内圈刻线" },
  { key: "yangwen", name: "阳文", desc: "描边留白：印底透纸，字着印色" },
];

const TONE_KEYS = new Set(AVATAR_TONES.map((t) => t.key));
const SHAPE_KEYS = new Set(AVATAR_SHAPES.map((s) => s.key));

/** 白名单校验（落库前用）；空串 = 随缘 */
export function cleanAvatarTone(v: unknown): string {
  const s = String(v ?? "").trim();
  return TONE_KEYS.has(s) ? s : "";
}

export function cleanAvatarShape(v: unknown): string {
  const s = String(v ?? "").trim();
  return SHAPE_KEYS.has(s) ? s : "";
}

/**
 * 印泥派定：显式选择优先；未设置（''）时按用户 id 确定性派色。
 * 同一用户在任何渲染面都得到同一印色（无 DB 数据的面也能用 id 兜底）。
 */
export function toneClass(tone: string | null | undefined, userId?: number | null): string {
  if (tone && TONE_KEYS.has(tone)) return `avt-${tone}`;
  const id = Number(userId ?? 0);
  const pick = AUTO_POOL[(Number.isFinite(id) && id > 0 ? id : 0) % AUTO_POOL.length];
  return `avt-${pick.key}`;
}

/** 印式 class：''（圆章）不额外加 class */
export function shapeClass(shape: string | null | undefined): string {
  const s = String(shape ?? "").trim();
  return s === "fang" || s === "yangwen" ? `avs-${s}` : "";
}

/** 组合 class：tone + shape 一次拼好 */
export function avatarClasses(
  tone: string | null | undefined,
  shape: string | null | undefined,
  userId?: number | null
): string {
  return [toneClass(tone, userId), shapeClass(shape)].filter(Boolean).join(" ");
}
