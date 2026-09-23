package com.inkstack.mapper;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/** 上传登记。写失败不阻塞响应——文件已经在盘上了，缺一行索引不该让用户的图丢掉。 */
@Mapper
public interface UploadMapper {

  /** {@code mime} 存的是<b>客户端声明</b>的类型（Node 同式），真实类型由魔数校验把关。 */
  @Insert("""
      INSERT INTO uploads (user_id, filename, mime, size)
       VALUES (#{uid}, #{filename}, #{mime}, #{size})
      """)
  int register(
      @Param("uid") long uid,
      @Param("filename") String filename,
      @Param("mime") String mime,
      @Param("size") long size);
}
