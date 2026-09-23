package com.inkstack.common;

import java.util.Set;

/**
 * 印章工坊的两个白名单，对齐 {@code lib/avatar.ts} 的 {@code cleanAvatarTone} / {@code cleanAvatarShape}。
 *
 * <p>白名单而不是正则：色板 key 与印式 key 都是<b>渲染层的 CSS 类名片段</b>（{@code avt-zhusha}、
 * {@code avs-fang}）。写进库的字符串会被前端拼进 class，放开校验等于让任意字符串进样式表。
 * 判据是"不在集合里就落空串"，空串本身是有意义的取值（随缘派色 / 默认圆章），所以不报错、只降级。
 */
public final class Avatars {

  /** 色板：经典墨 + 六种传统印泥/矿物色。 */
  private static final Set<String> TONES =
      Set.of("ink", "zhusha", "dailan", "zhuqing", "zheshi", "zitang", "yanzhi");

  /** 印式：空串 = 圆章（默认），另有方章与阳文。 */
  private static final Set<String> SHAPES = Set.of("", "fang", "yangwen");

  private Avatars() {}

  public static String cleanTone(String raw) {
    String value = NodeShapes.jsTrim(NodeShapes.text(raw));
    return TONES.contains(value) ? value : "";
  }

  public static String cleanShape(String raw) {
    String value = NodeShapes.jsTrim(NodeShapes.text(raw));
    return SHAPES.contains(value) ? value : "";
  }
}
