/**
 * 头像展示工具：avatar 字段存「Emoji 或图片 URL」的短字符串（后端上限 255）。
 *
 * <p>渲染时分流：URL（http/https/data:image）走 <img>，其余按 Emoji/文本渲染。
 * 之所以不做格式强校验，是因为头像只是展示性字段，写错也不影响功能。</p>
 */

/** 是否为图片 URL 头像（否则按 Emoji/文本渲染） */
export const isImageAvatar = (avatar?: string | null): boolean =>
  !!avatar && /^(https?:\/\/|data:image\/)/i.test(avatar.trim());

/** 原生 <option> 无法渲染图片：URL 头像在下拉框里退化为纯文本标签 */
export const avatarOptionPrefix = (avatar?: string | null): string =>
  avatar && !isImageAvatar(avatar) ? `${avatar.trim()} ` : '';
