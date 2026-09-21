package com.inkstack.comment;

import com.inkstack.common.NodeShapes;
import com.inkstack.entity.CommentRow;

/** 评论项视图，字段集合与 Node listComments 的映射结果一致（含 viewerLiked 的 int→bool 归真）。 */
public record CommentView(
    long id,
    String nickname,
    String content,
    String createdAt,
    Long parentId,
    String parentAuthor,
    long likes,
    boolean viewerLiked,
    Long userId,
    String avatarText,
    String avatarTone,
    String avatarShape) {

  public static CommentView from(CommentRow row) {
    return new CommentView(
        NodeShapes.num(row.getId()), NodeShapes.text(row.getNickname()),
        NodeShapes.text(row.getContent()), NodeShapes.text(row.getCreatedAt()),
        row.getParentId(), NodeShapes.text(row.getParentAuthor()), NodeShapes.num(row.getLikes()),
        NodeShapes.flag(row.getViewerLiked()), row.getUserId(), NodeShapes.text(row.getAvatarText()),
        NodeShapes.text(row.getAvatarTone()), NodeShapes.text(row.getAvatarShape()));
  }
}
