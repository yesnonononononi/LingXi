// 配色全部取自原型图（采样脚本见 .lingxi/tmp/sample2.ps1），改色只改这里。
export const PALETTE = Object.freeze({
  /** 毛发主色，几乎纯白但带一点暖调，避免死白 */
  hair: '#FDFBF8',
  /** 毛发阴影 / 尾巴外侧 */
  hairShade: '#E9E2DC',
  /** 皮肤 */
  skin: '#FDF1E9',
  /** 皮肤阴影（下巴、耳朵内侧过渡） */
  skinShade: '#F6DFD5',
  /** 淡粉：腮红、内耳、蝴蝶结高光 */
  blush: '#FBDED7',
  /** 米杏：连衣裙 */
  cream: '#EBDFD9',
  /** 连衣裙阴影 */
  creamShade: '#DDCFC7',
  /** 雾蓝：蝴蝶结面 */
  ribbon: '#A9C3DF',
  /** 雾蓝深色：蝴蝶结阴影、眼睛描边 */
  ribbonDeep: '#8FAFD1',
  /** 眼睛主色 */
  eye: '#7FA6CC',
  /** 眼睛深色（瞳孔/上眼睑） */
  eyeDeep: '#5E87B0',
  /** 描边暖棕，很淡，Q 版软描边 */
  outline: '#D9C4B6',
  /** 气泡背景 */
  bubble: '#FFFFFF',
  /** 气泡文字 */
  ink: '#6B5B52',
});

/** 供 CSS 使用的变量表，保证 SVG 与气泡风格统一。 */
export const CSS_VARS = Object.freeze({
  '--pet-hair': PALETTE.hair,
  '--pet-hair-shade': PALETTE.hairShade,
  '--pet-skin': PALETTE.skin,
  '--pet-skin-shade': PALETTE.skinShade,
  '--pet-blush': PALETTE.blush,
  '--pet-cream': PALETTE.cream,
  '--pet-cream-shade': PALETTE.creamShade,
  '--pet-ribbon': PALETTE.ribbon,
  '--pet-ribbon-deep': PALETTE.ribbonDeep,
  '--pet-eye': PALETTE.eye,
  '--pet-eye-deep': PALETTE.eyeDeep,
  '--pet-outline': PALETTE.outline,
  '--pet-bubble': PALETTE.bubble,
  '--pet-ink': PALETTE.ink,
});

