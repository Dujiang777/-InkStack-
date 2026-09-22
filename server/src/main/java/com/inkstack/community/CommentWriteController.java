package com.inkstack.community;

import com.fasterxml.jackson.databind.JsonNode;
import com.inkstack.common.NodeShapes;
import com.inkstack.community.CommunityService.Added;
import com.inkstack.community.CommunityService.Rewards;
import com.inkstack.session.SessionUser;
import com.inkstack.web.Bodies;
import com.inkstack.web.Current;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 评论区的三条写接口：发文、点赞、举报。
 *
 * <p>评论允许游客提交（昵称走 guest_nickname），所以这里没有一律 401 的前置闸；
 * 点赞与举报则登录限定。响应里 {@code comment} 那一项是给前端替换占位行用的真实行，
 * 键序必须与 Node 一致，否则对拍会报出顺序差异。
 */
@RestController
public class CommentWriteController {

  private final CommunityService community;
  private final ReportService reports;

  public CommentWriteController(CommunityService community, ReportService reports) {
    this.community = community;
    this.reports = reports;
  }

  @PostMapping("/api/articles/{slug}/comments")
  public ResponseEntity<Map<String, Object>> add(
      @Current SessionUser me, @PathVariable String slug, HttpServletRequest request) {
    JsonNode body = Bodies.json(request);
    String rawNickname = Bodies.text(body, "nickname");
    String rawContent = Bodies.text(body, "content");
    double rawParent = Bodies.number(body, "parentId");
    Double parentId = rawParent > 0 ? rawParent : null;

    Added added = community.addComment(slug, rawNickname, rawContent, parentId, me);
    if (!added.ok()) {
      return err(400, added.error());
    }
    Rewards rewards = community.rewardAndNotify(slug, parentId, me, added.nickname());

    Map<String, Object> comment = null;
    if (added.id() != null) {
      comment = new LinkedHashMap<>();
      comment.put("id", added.id());
      comment.put("nickname", added.nickname());
      comment.put("content", NodeShapes.jsTrim(rawContent));
      comment.put("createdAt", added.createdAt());
      comment.put("parentId", parentId);
      comment.put("parentAuthor", community.parentAuthor(parentId));
      comment.put("likes", 0);
      comment.put("viewerLiked", false);
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("asUser", me != null);
    out.put("rewards", rewardsBody(rewards));
    out.put("comment", comment);
    return ResponseEntity.ok(out);
  }

  @PostMapping("/api/comments/{id}/like")
  public ResponseEntity<Map<String, Object>> like(
      @Current SessionUser me, @PathVariable String id) {
    if (me == null) {
      return err(401, "登录后才能点赞评论");
    }
    long commentId = Bodies.positiveId(id);
    if (commentId <= 0) {
      return err(400, "参数无效");
    }
    CommunityService.CommentLiked r = community.toggleCommentLike(me.id(), commentId);
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("liked", r.liked());
    out.put("likes", r.likes());
    return ResponseEntity.ok(out);
  }

  @PostMapping("/api/comments/{id}/report")
  public ResponseEntity<Map<String, Object>> report(
      @Current SessionUser me, @PathVariable String id, HttpServletRequest request) {
    if (me == null) {
      return err(401, "登录后才能举报");
    }
    long commentId = Bodies.positiveId(id);
    if (commentId <= 0) {
      return err(400, "评论不存在");
    }
    String reason = NodeShapes.slice(NodeShapes.jsTrim(Bodies.text(Bodies.json(request), "reason")), 255);
    if (reason.length() < 2) {
      return err(400, "请填写举报原因（至少 2 字）");
    }
    switch (reports.submitComment(me.id(), commentId, reason)) {
      case OK -> {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("message", "举报已提交，运营会尽快核查");
        return ResponseEntity.ok(out);
      }
      case NOT_FOUND -> {
        return err(404, "评论不存在或已被删除");
      }
      case DUPLICATE -> {
        return err(409, "该评论已有你提交的举报待处理，请耐心等待");
      }
      default -> {
        return err(500, "举报失败，请稍后再试");
      }
    }
  }

  private static Map<String, Object> rewardsBody(Rewards rewards) {
    Map<String, Object> out = new LinkedHashMap<>();
    if (rewards.commentator() != null) {
      out.put("commentator", rewards.commentator());
    }
    if (rewards.author() != null) {
      out.put("author", rewards.author());
    }
    return out;
  }

  private static ResponseEntity<Map<String, Object>> err(int status, String error) {
    return ResponseEntity.status(status).body(Map.of("error", error));
  }
}
